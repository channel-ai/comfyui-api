import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { armJobWatchdog } from "../src/job-watchdog";
import { CommandExecutor } from "../src/commands";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("armJobWatchdog", () => {
  it("fires onTimeout when not cleared in time (wedged job)", async () => {
    let fired = 0;
    armJobWatchdog(20, () => fired++);
    await wait(60);
    assert.strictEqual(fired, 1);
  });

  it("does not fire when cleared before the timeout (job finished)", async () => {
    let fired = 0;
    const wd = armJobWatchdog(50, () => fired++);
    await wait(10);
    wd.clear();
    await wait(70);
    assert.strictEqual(fired, 0);
  });

  it("is disabled when timeoutMs <= 0", async () => {
    let fired = 0;
    const wd = armJobWatchdog(0, () => fired++);
    await wait(20);
    wd.clear();
    assert.strictEqual(fired, 0);
  });
});

describe("CommandExecutor.kill", () => {
  /**
   * The watchdog's whole job is releasing ComfyUI's memory. `comfy launch` is
   * only a wrapper — main.py is the grandchild holding the RSS — so killing
   * the direct child alone would leave the cgroup just as wedged.
   */
  it("kills grandchildren, not just the direct child", async () => {
    const pidFile = path.join(os.tmpdir(), `comfyui-api-kill-test-${process.pid}`);
    fs.rmSync(pidFile, { force: true });

    const exec = new CommandExecutor();
    // rejects when we SIGKILL it; that's the expected end state
    exec
      .execute("sh", ["-c", `sleep 300 & echo $! > ${pidFile}; wait`], {})
      .catch(() => {});

    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await wait(20);
    const grandchild = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    assert.ok(alive(grandchild), "grandchild should be running before kill()");

    exec.kill();

    for (let i = 0; i < 100 && alive(grandchild); i++) await wait(20);
    assert.ok(!alive(grandchild), "kill() must reap the whole process group");
    fs.rmSync(pidFile, { force: true });
  });
});
