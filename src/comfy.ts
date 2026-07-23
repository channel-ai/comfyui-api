import { sleep } from "./utils";
import config from "./config";
import { CommandExecutor } from "./commands";
import { HistoryEndpointPoller } from "./history-poller";
import { armJobWatchdog } from "./job-watchdog";
import { FastifyBaseLogger } from "fastify";
import {
  ComfyPrompt,
  ComfyWSMessage,
  isStatusMessage,
  isProgressMessage,
  isProgressStateMessage,
  isExecutionStartMessage,
  isExecutionCachedMessage,
  isExecutedMessage,
  isExecutionSuccessMessage,
  isExecutingMessage,
  isExecutionInterruptedMessage,
  isExecutionErrorMessage,
  WebhookHandlers,
  ComfyPromptResponse,
  ComfyHistoryResponse,
  ExecutionStats,
  isExecutionStats,
} from "./types";
import path from "path";
import fsPromises from "fs/promises";
import WebSocket, { MessageEvent } from "ws";
import { fetch } from "undici";
import { getProxyDispatcher } from "./proxy-dispatcher";
import { z } from "zod";

const commandExecutor = new CommandExecutor();

export function launchComfyUI() {
  const cmdAndArgs = config.comfyLaunchCmd.split(" ");
  const cmd = cmdAndArgs[0];
  const args = cmdAndArgs.slice(1);
  return commandExecutor.execute(cmd, args, {
    DIRECT_ADDRESS: config.comfyHost,
    COMFYUI_PORT_HOST: config.comfyPort,
    WEB_ENABLE_AUTH: "false",
    CF_QUICK_TUNNELS: "false",
  });
}

export function shutdownComfyUI() {
  commandExecutor.interrupt();
}

export async function pingComfyUI(): Promise<void> {
  const res = await fetch(config.comfyURL, {
    dispatcher: getProxyDispatcher(),
  });
  if (!res.ok) {
    throw new Error(`Failed to ping Comfy UI: ${await res.text()}`);
  }
}

export async function waitForComfyUIToStart(
  log: FastifyBaseLogger
): Promise<void> {
  let retries = 0;
  while (retries < config.startupCheckMaxTries) {
    try {
      await pingComfyUI();
      log.info("Comfy UI started");
      return;
    } catch (e) {
      // Ignore
    }
    retries++;
    await sleep(config.startupCheckInterval);
  }

  throw new Error(
    `Comfy UI did not start after ${
      (config.startupCheckInterval / 1000) * config.startupCheckMaxTries
    } seconds`
  );
}

export async function warmupComfyUI(): Promise<void> {
  if (config.warmupPrompt) {
    const resp = await fetch(`http://localhost:${config.wrapperPort}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Warmup runs a full generation and can be legitimately slow (cold
        // model load). Tag it so the /prompt handler skips the self-kill
        // watchdog — otherwise a slow warmup redeploys the container in a loop.
        "x-comfyui-api-warmup": "true",
      },
      body: JSON.stringify({ prompt: config.warmupPrompt }),
      dispatcher: getProxyDispatcher(),
    });
    if (!resp.ok) {
      throw new Error(`Failed to warmup Comfy UI: ${await resp.text()}`);
    }
  }
}

export async function queuePrompt(prompt: ComfyPrompt): Promise<string> {
  const resp = await fetch(`${config.comfyURL}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt, client_id: config.wsClientId }),
    dispatcher: getProxyDispatcher(),
  });
  if (!resp.ok) {
    throw new Error(`Failed to queue prompt: ${await resp.text()}`);
  }
  const { prompt_id } = (await resp.json()) as ComfyPromptResponse;
  return prompt_id;
}

export type PromptOutputs = {
  files: Record<string, Buffer>;
  metadata: Record<string, any[]>;
} | null;

export async function getPromptOutputs(
  promptId: string,
  log: FastifyBaseLogger
): Promise<PromptOutputs> {
  const resp = await fetch(`${config.comfyURL}/history/${promptId}`, {
    dispatcher: getProxyDispatcher(),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    log.error(`Failed to get prompt outputs: ${txt}`);
    throw new Error(`Failed to get prompt outputs: ${txt}`);
  }
  const body = (await resp.json()) as ComfyHistoryResponse;
  const allOutputs: Record<string, Buffer> = {};
  const allMetadata: Record<string, any[]> = {};
  const fileLoadPromises: Promise<void>[] = [];
  if (!body[promptId]) {
    log.debug(`Prompt ${promptId} not found in history endpoint response`);
    return null;
  }
  const { status, outputs } = body[promptId];
  if (status.completed) {
    for (const nodeId in outputs) {
      const node = outputs[nodeId];
      for (const outputType in node) {
        for (let outputFile of node[outputType]) {
          const filename = outputFile.filename;
          if (!filename) {
            /**
             * Some nodes have fields in the outputs that are not actual files.
             * Collect these as metadata (e.g., moderation data from custom nodes).
             */
            if (!allMetadata[outputType]) {
              allMetadata[outputType] = [];
            }
            allMetadata[outputType].push(outputFile);
            continue;
          }
          const filepath = path.join(config.outputDir, filename);
          fileLoadPromises.push(
            fsPromises
              .readFile(filepath)
              .then((data) => {
                allOutputs[filename] = data;
              })
              .catch((e: any) => {
                /**
                 * The most likely reason for this is a node that has an optonal
                 * output. If the node doesn't produce that output, the file won't
                 * exist.
                 */
                log.warn(`Failed to read file ${filepath}: ${e.message}`);
              })
          );
        }
      }
    }
  } else if (status.status_str === "error") {
    log.error(JSON.stringify(status));
    throw new Error("Prompt execution failed");
  } else {
    log.debug(JSON.stringify(status));
    throw new Error("Prompt is not completed");
  }
  await Promise.all(fileLoadPromises);
  return { files: allOutputs, metadata: allMetadata };
}

async function collectExecutionStats(
  promptId: string,
  log: FastifyBaseLogger
): Promise<ExecutionStats> {
  let start = Date.now();
  return new Promise((resolve, reject) => {
    const stats: ExecutionStats = {
      comfy_execution: { start, end: 0, duration: 0, nodes: {} },
    };
    const handleMessage = (event: MessageEvent) => {
      const { data } = event;
      if (typeof data === "string") {
        const message = JSON.parse(data) as ComfyWSMessage;
        if (message?.data?.prompt_id !== promptId) return;
        if (isExecutionStartMessage(message)) {
          start = Date.now();
          stats.comfy_execution.start = start;
          log.info(`Prompt ${promptId} started execution`);
        } else if (isExecutingMessage(message)) {
          const nodeId = message.data.node;
          if (!nodeId) return;
          stats.comfy_execution.nodes[nodeId] = {
            start: Date.now(),
          };
        } else if (isExecutionSuccessMessage(message)) {
          stats.comfy_execution.end = Date.now();
          stats.comfy_execution.duration =
            stats.comfy_execution.end - stats.comfy_execution.start;
          wsClient?.removeEventListener("close", onClose);
          wsClient?.removeEventListener("message", handleMessage);
          log.info(`Prompt ${promptId} completed execution`);
          return resolve(stats);
        } else if (isExecutionErrorMessage(message)) {
          wsClient?.removeEventListener("close", onClose);
          wsClient?.removeEventListener("message", handleMessage);
          return reject(new Error("Prompt execution failed"));
        } else if (isExecutionInterruptedMessage(message)) {
          wsClient?.removeEventListener("close", onClose);
          wsClient?.removeEventListener("message", handleMessage);
          return reject(new Error("Prompt execution interrupted"));
        }
      }
    };

    const onClose = () => {
      wsClient?.removeEventListener("message", handleMessage);
      wsClient?.removeEventListener("close", onClose);
      return reject(new Error("Websocket closed"));
    };
    wsClient?.addEventListener("message", handleMessage);
    wsClient?.addEventListener("close", onClose);
  });
}

export const comfyIDToApiID: Record<string, string> = {};

export type PromptOutputsWithStats = {
  outputs: Record<string, Buffer>;
  stats: ExecutionStats;
  metadata: Record<string, any[]>;
};

export async function runPromptAndGetOutputs(
  id: string,
  prompt: ComfyPrompt,
  log: FastifyBaseLogger,
  watchdogMs: number = config.jobTimeoutMs
): Promise<PromptOutputsWithStats> {
  const promptId = await queuePrompt(prompt);
  comfyIDToApiID[promptId] = id;
  log.debug(`Prompt ${id} queued as comfy prompt id: ${promptId}`);

  /**
   * Self-kill watchdog: if this prompt neither completes nor errors within
   * jobTimeoutMs, ComfyUI is almost certainly wedged (e.g. a VAE-decode
   * deadlock — GPU idle, uninterruptible). A hung job pins its inFlight slot
   * forever, so we exit and let the orchestrator redeploy a fresh replica.
   */
  const watchdog = armJobWatchdog(watchdogMs, () => {
    log.fatal(
      `Prompt ${id} (comfy ${promptId}) did not finish within ${watchdogMs}ms; ` +
        `ComfyUI is likely wedged. Exiting to trigger redeploy.`
    );
    process.exit(1);
  });
  try {
  /**
   * We start with a slow poll to the history endpoint, both as a safety measure around websocket
   * failures, and to avoid hammering the history endpoint with requests in the case of many queued
   * prompts.
   */
  const poller = new HistoryEndpointPoller({
    promptId,
    log,
    maxTries: 0,
    interval: 1000,
    getOutputs: () => getPromptOutputs(promptId, log),
  });
  const historyPoll = poller.poll();

  /**
   * We also listen to the websocket stream for the prompt to complete.
   */
  const executionStatsPromise = collectExecutionStats(promptId, log);

  /**
   * We wait for either the history endpoint to return the outputs, or the websocket
   * to signal that the prompt has completed.
   */
  let firstToComplete:
    | { files: Record<string, Buffer>; metadata: Record<string, any[]> }
    | ExecutionStats
    | null;
  try {
    firstToComplete = await Promise.race([historyPoll, executionStatsPromise]);
  } catch (e) {
    /**
     * If an error is thrown by either of those processes, we stop the polling and
     * throw an error.
     */
    log.error(`Error waiting for prompt to complete: ${e}`);
    firstToComplete = null;
  }

  if (isExecutionStats(firstToComplete)) {
    /**
     * If the websocket signals that the prompt has completed (this is typical), we can speed
     * up the history endpoint polling, as it should only need 1-2 tries to get the outputs.
     */
    log.info(`Prompt ${id} completed`);
    poller.setMaxTries(100);
    poller.setInterval(30);
    const result = await historyPoll;
    /**
     * We delete the comfyIDToApiID mapping after a short delay to prevent
     * this object from growing indefinitely.
     */
    setTimeout(() => {
      delete comfyIDToApiID[promptId];
    }, 1000);
    if (result) {
      return {
        outputs: result.files,
        stats: firstToComplete,
        metadata: result.metadata,
      };
    }
    throw new Error("Failed to get prompt outputs");
  } else if (firstToComplete === null) {
    poller.stop();
    throw new Error("Failed to get prompt outputs");
  }
  /**
   * If we reach this point, it means that the history endpoint returned the outputs
   * before the websocket signaled that the prompt had completed. This is unexpected,
   * but fine. We return the outputs and delete the comfyIDToApiID mapping.
   */
  setTimeout(() => {
    /**
     * We delete the comfyIDToApiID mapping after a short delay to prevent
     * this object from growing indefinitely.
     */
    delete comfyIDToApiID[promptId];
  }, 1000);
  const { files: outputs, metadata } = firstToComplete;
  const stats = await executionStatsPromise;
  return { outputs, stats, metadata };
  } finally {
    watchdog.clear();
  }
}

let wsClient: WebSocket | null = null;

export function connectToComfyUIWebsocketStream(
  hooks: WebhookHandlers,
  log: FastifyBaseLogger,
  useApiIDs: boolean = true
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    wsClient = new WebSocket(config.comfyWSURL);
    wsClient.on("message", (data, isBinary) => {
      if (hooks.onMessage) {
        hooks.onMessage(data);
      }
      if (!isBinary) {
        const message = JSON.parse(data.toString("utf8")) as ComfyWSMessage;
        if (
          useApiIDs &&
          message.data.prompt_id &&
          comfyIDToApiID[message.data.prompt_id]
        ) {
          message.data.prompt_id = comfyIDToApiID[message.data.prompt_id];
        }
        if (isStatusMessage(message) && hooks.onStatus) {
          hooks.onStatus(message);
        } else if (isProgressMessage(message) && hooks.onProgress) {
          hooks.onProgress(message);
        } else if (isExecutionStartMessage(message) && hooks.onExecutionStart) {
          hooks.onExecutionStart(message);
        } else if (
          isExecutionCachedMessage(message) &&
          hooks.onExecutionCached
        ) {
          hooks.onExecutionCached(message);
        } else if (isExecutingMessage(message) && hooks.onExecuting) {
          hooks.onExecuting(message);
        } else if (isExecutedMessage(message) && hooks.onExecuted) {
          hooks.onExecuted(message);
        } else if (
          isExecutionSuccessMessage(message) &&
          hooks.onExecutionSuccess
        ) {
          hooks.onExecutionSuccess(message);
        } else if (
          isExecutionInterruptedMessage(message) &&
          hooks.onExecutionInterrupted
        ) {
          hooks.onExecutionInterrupted(message);
        } else if (isExecutionErrorMessage(message) && hooks.onExecutionError) {
          hooks.onExecutionError(message);
        } else if (isProgressStateMessage(message) && hooks.onProgressState) {
          if (useApiIDs && message.data.nodes) {
            for (const nodeId in message.data.nodes) {
              const node = message.data.nodes[nodeId];
              if (node.prompt_id && comfyIDToApiID[node.prompt_id]) {
                node.prompt_id = comfyIDToApiID[node.prompt_id];
              }
            }
          }
          hooks.onProgressState(message);
        }
      } else {
        log.info(`Received binary message`);
      }
    });

    wsClient.on("open", () => {
      log.info("Connected to Comfy UI websocket");

      return resolve(wsClient as WebSocket);
    });
    wsClient.on("error", (error) => {
      log.error(`Failed to connect to Comfy UI websocket: ${error}`);
      return reject(error);
    });

    wsClient.on("close", () => {
      log.info("Disconnected from Comfy UI websocket");
    });
  });
}

export async function getModels(): Promise<
  Record<
    string,
    {
      dir: string;
      all: string[];
      enum: z.ZodEnum<[string, ...string[]]>;
    }
  >
> {
  const modelsResp = await fetch(`${config.comfyURL}/models`, {
    dispatcher: getProxyDispatcher(),
  });

  if (!modelsResp.ok) {
    throw new Error(`Failed to fetch model types: ${await modelsResp.text()}`);
  }

  const modelTypes = (await modelsResp.json()) as Array<string>;
  const modelsByType: Record<
    string,
    { dir: string; all: string[]; enum: z.ZodEnum<[string, ...string[]]> }
  > = {};

  const modelPromises = modelTypes.map(async (modelType) => {
    const resp = await fetch(`${config.comfyURL}/models/${modelType}`, {
      dispatcher: getProxyDispatcher(),
    });

    if (!resp.ok) {
      throw new Error(
        `Failed to fetch models for type ${modelType}: ${await resp.text()}`
      );
    }

    const models = (await resp.json()) as Array<string>;
    modelsByType[modelType] = {
      dir: path.join(config.modelDir, modelType),
      all: models,
      enum: z.enum(models as [string, ...string[]]),
    };
  });
  await Promise.all(modelPromises);

  config.models = modelsByType;
  return modelsByType;
}

export async function interruptPrompt(id: string): Promise<void> {
  const comfyPromptId = Object.keys(comfyIDToApiID).find(
    (key) => comfyIDToApiID[key] === id
  );

  if (!comfyPromptId) {
    throw new Error(`Prompt ${id} not found`);
  }

  const resp = await fetch(`${config.comfyURL}/interrupt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt_id: comfyPromptId }),
    dispatcher: getProxyDispatcher(),
  });
  if (!resp.ok) {
    throw new Error(`Failed to interrupt prompt: ${await resp.text()}`);
  }
}
