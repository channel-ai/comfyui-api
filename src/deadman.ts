import { spawn } from "child_process";
import fs from "fs";

/**
 * Out-of-process liveness kill. The in-process job watchdog is a JS timer and
 * dies with the event loop — observed in prod: the runtime deadlocked (main
 * thread parked on a futex), the port kept accepting TCP without responding,
 * and the box zombied for 20h with the watchdog armed but unable to fire.
 * Only another OS process can kill a frozen Node process.
 *
 * The event loop touches a heartbeat file every beatSeconds; a detached shell
 * loop SIGKILLs ComfyUI's process group and then the API when the file goes
 * staleSeconds without a touch. ComfyUI dies first for the same reason the
 * job watchdog kills it first: its RSS can pin the cgroup over memory.high,
 * and freeing that is what lets anything else in the cgroup run. The shell
 * loop exits on its own once the API is dead.
 */
export function startHeartbeat(file: string, beatSeconds = 10): NodeJS.Timeout {
  fs.writeFileSync(file, "");
  const timer = setInterval(() => {
    const now = new Date();
    fs.utimesSync(file, now, now);
  }, beatSeconds * 1000);
  timer.unref();
  return timer;
}

export function armDeadman(
  file: string,
  apiPid: number,
  comfyPid: number | undefined,
  staleSeconds = 90,
  checkSeconds = 15
): void {
  const killComfy = comfyPid ? `kill -9 -- -${comfyPid} 2>/dev/null; ` : "";
  const script =
    `while kill -0 ${apiPid} 2>/dev/null; do ` +
    `sleep ${checkSeconds}; ` +
    `now=$(date +%s); ` +
    // stat -c is GNU (prod), stat -f is BSD (dev)
    `mt=$(stat -c %Y "${file}" 2>/dev/null || stat -f %m "${file}" 2>/dev/null || echo 0); ` +
    `if [ $((now - mt)) -ge ${staleSeconds} ]; then ${killComfy}kill -9 ${apiPid} 2>/dev/null; exit 0; fi; ` +
    `done`;
  spawn("sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
}
