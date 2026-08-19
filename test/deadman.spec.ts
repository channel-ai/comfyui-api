import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { armDeadman, startHeartbeat } from "../src/deadman";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("deadman", () => {
  it("kills the target when the heartbeat goes stale", async () => {
    const hb = path.join(os.tmpdir(), `deadman-stale-${process.pid}`);
    fs.writeFileSync(hb, "");
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(hb, old, old);

    const target = spawn("sleep", ["300"]);
    armDeadman(hb, target.pid!, undefined, 3, 1);

    for (let i = 0; i < 100 && alive(target.pid!); i++) await wait(100);
    assert.ok(!alive(target.pid!), "stale heartbeat must get the target killed");
    fs.rmSync(hb, { force: true });
  });

  it("leaves the target alone while the heartbeat is fresh", async () => {
    const hb = path.join(os.tmpdir(), `deadman-fresh-${process.pid}`);
    const timer = startHeartbeat(hb, 1);

    const target = spawn("sleep", ["300"]);
    armDeadman(hb, target.pid!, undefined, 3, 1);

    await wait(5000);
    assert.ok(alive(target.pid!), "fresh heartbeat must keep the target alive");
    clearInterval(timer);
    target.kill("SIGKILL");
    fs.rmSync(hb, { force: true });
  });
});
