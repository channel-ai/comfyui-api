import assert from "node:assert";
import { HistoryEndpointPoller } from "../src/history-poller";

const log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as any;

const settle = () => new Promise((r) => setTimeout(r, 25));

describe("HistoryEndpointPoller", () => {
  it("stop() during the first try terminates the poll (regression: infinite hot loop)", async () => {
    let calls = 0;
    const poller = new HistoryEndpointPoller({
      promptId: "test",
      log,
      maxTries: 0,
      interval: 1000,
      getOutputs: async () => {
        calls++;
        return null;
      },
    });
    const pollPromise = poller.poll();
    poller.stop(); // currentTries is still 0 here
    assert.strictEqual(await pollPromise, null);
    const callsAtStop = calls;
    await settle();
    assert.strictEqual(calls, callsAtStop, "poller kept polling after stop()");
  });

  it("stop() after some tries terminates promptly", async () => {
    let calls = 0;
    const poller = new HistoryEndpointPoller({
      promptId: "test",
      log,
      maxTries: 0,
      interval: 1,
      getOutputs: async () => {
        calls++;
        return null;
      },
    });
    const pollPromise = poller.poll();
    await settle();
    assert.ok(calls > 1, "expected several tries before stop()");
    poller.stop();
    assert.strictEqual(await pollPromise, null);
    const callsAtStop = calls;
    await settle();
    assert.strictEqual(calls, callsAtStop, "poller kept polling after stop()");
  });

  it("returns outputs once they become available", async () => {
    let calls = 0;
    const outputs = { files: {}, metadata: {} };
    const poller = new HistoryEndpointPoller({
      promptId: "test",
      log,
      maxTries: 0,
      interval: 1,
      getOutputs: async () => (++calls < 3 ? null : outputs),
    });
    assert.strictEqual(await poller.poll(), outputs);
  });

  it("gives up after maxTries", async () => {
    let calls = 0;
    const poller = new HistoryEndpointPoller({
      promptId: "test",
      log,
      maxTries: 2,
      interval: 1,
      getOutputs: async () => {
        calls++;
        return null;
      },
    });
    assert.strictEqual(await poller.poll(), null);
    assert.strictEqual(calls, 2);
  });
});
