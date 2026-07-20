import assert from "node:assert";
import { armJobWatchdog } from "../src/job-watchdog";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
