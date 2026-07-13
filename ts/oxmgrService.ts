import { liveEnv } from "./nodeRuntime.ts";
// Register oxmgr's daemon with the platform init system (launchd on macOS,
// systemd on Linux, Task Scheduler on Windows) so managed processes survive a
// *reboot*, not just a crash.
//
// CHEAP + idempotent: it first checks `oxmgr service status` and SKIPS the
// install when the service is already registered. This matters a lot —
// re-running `oxmgr service install` re-bootstraps the launchd/systemd job,
// which restarts the oxmgr daemon itself, and a daemon restart kills and
// relaunches EVERY managed process (not just ours). Doing that on every
// `ay serve install` / `ay schedule` was bouncing unrelated daemons — e.g. a
// VS Code `serve-web` server running under another managed process, which took
// the user's editor (and any agent running inside it) down with it.
//
// Best-effort: returns false on any failure (e.g. a system-level systemd unit
// that needs sudo) without aborting the caller — the process is still managed,
// just not boot-persistent.
export async function ensureBootAutostart(oxmgrBin: string): Promise<boolean> {
  try {
    // Already registered with the init system? Then we're done — don't bounce
    // the daemon (and all its children) just to re-assert what's already true.
    // env: liveEnv() so the node→bun shim's PATH prepend reaches oxmgr's
    // `#!/usr/bin/env node` launcher (implicit inheritance uses the startup
    // environ, missing post-startup mutations).
    const status = Bun.spawn([oxmgrBin, "service", "status"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: liveEnv(),
    });
    if ((await status.exited) === 0) return true;

    // Not registered yet → install. `--system` defaults to "auto"
    // (launchd/systemd/Task Scheduler by platform); it's a `service`-level flag,
    // so passing it after `install` is rejected.
    const svc = Bun.spawn([oxmgrBin, "service", "install"], {
      stdio: ["ignore", "ignore", "ignore"],
      env: liveEnv(),
    });
    return (await svc.exited) === 0;
  } catch {
    return false;
  }
}
