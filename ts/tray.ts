import { existsSync } from "fs";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { getRunningAgentCount, type Task } from "./runningLock.ts";

const POLL_INTERVAL = 2000;

const getTrayDir = () => path.join(process.env.CLAUDE_YES_HOME || homedir(), ".claude-yes");
const getTrayPidFile = () => path.join(getTrayDir(), "tray.pid");

// Minimal 16x16 white circle PNG as base64 (used as tray icon)
const ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA" +
  "jklEQVQ4T2NkoBAwUqifgWoGMDIyNjAyMv5nYGBYQMgVjMgC" +
  "QM0LGBkZHYDYAY8BDUBxByB2wGcAyAUOQOwAxPYMDAyOeCzA" +
  "bwBIMyMjowNQsz0ely8ACjng8wJeA0CaGRgY7IHYAZ8hQHEH" +
  "fF7AawBYMwODPZABRHsBpwEgzUDN9kDsgM8lQHEHfC4gJhwA" +
  "AM3hMBGq3cNNAAAAAElFTkSuQmCC";

function buildMenuItems(tasks: Task[]) {
  const items = [];

  if (tasks.length === 0) {
    items.push({ title: "No running agents", tooltip: "", enabled: false });
  } else {
    items.push({
      title: `Running agents: ${tasks.length}`,
      tooltip: "",
      enabled: false,
    });
    items.push({ title: "---", tooltip: "", enabled: false });
    for (const task of tasks) {
      const dir = task.cwd.replace(/^.*[/\\]/, "");
      const desc = task.task ? ` - ${task.task.slice(0, 40)}` : "";
      items.push({
        title: `[${task.pid}] ${dir}${desc}`,
        tooltip: task.cwd,
        enabled: false,
      });
    }
  }

  items.push({ title: "---", tooltip: "", enabled: false });
  items.push({ title: "Quit Tray", tooltip: "Exit tray icon", enabled: true });

  return items;
}

function isDesktopOS(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

function isTrayProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the current process PID to the tray PID file
 */
async function writeTrayPid(): Promise<void> {
  const dir = getTrayDir();
  await mkdir(dir, { recursive: true });
  await writeFile(getTrayPidFile(), String(process.pid), "utf8");
}

/**
 * Remove the tray PID file
 */
async function removeTrayPid(): Promise<void> {
  try {
    await unlink(getTrayPidFile());
  } catch {
    // ignore
  }
}

/**
 * Check if a tray process is already running
 */
export async function isTrayRunning(): Promise<boolean> {
  try {
    const pidFile = getTrayPidFile();
    if (!existsSync(pidFile)) return false;
    const pid = parseInt(await readFile(pidFile, "utf8"), 10);
    if (isNaN(pid)) return false;
    return isTrayProcessRunning(pid);
  } catch {
    return false;
  }
}

/**
 * Auto-spawn a tray process in the background if not already running.
 * Only spawns on desktop OS (macOS/Windows).
 * Silently does nothing if systray2 is not installed or on non-desktop OS.
 */
export async function ensureTray(): Promise<void> {
  if (!isDesktopOS()) return;
  if (await isTrayRunning()) return;

  try {
    // Resolve the CLI entry point (dist/cli.js or ts/cli.ts)
    const cliPath = new URL("./cli.ts", import.meta.url).pathname;
    const { spawn } = await import("child_process");

    // Spawn detached tray process
    const child = spawn(process.execPath, [cliPath, "--tray", "--no-rust"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
  } catch {
    // Silently fail — tray is best-effort
  }
}

export async function startTray(): Promise<void> {
  if (!isDesktopOS()) {
    console.error("Tray icon is only supported on macOS and Windows.");
    return;
  }

  // Check if another tray is already running
  if (await isTrayRunning()) {
    console.error("Tray is already running.");
    return;
  }

  // Register our PID
  await writeTrayPid();

  let SysTray: typeof import("systray2").default;
  try {
    SysTray = (await import("systray2")).default;
  } catch {
    await removeTrayPid();
    console.error("systray2 is not installed. Install it with: npm install systray2");
    return;
  }

  const { count, tasks } = await getRunningAgentCount();

  const systray = new SysTray({
    menu: {
      icon: ICON_BASE64,
      title: `AY: ${count}`,
      tooltip: `agent-yes: ${count} running`,
      items: buildMenuItems(tasks),
    },
    debug: false,
    copyDir: false,
  });

  await systray.ready();
  console.log(`Tray started. Watching ${count} running agent(s).`);

  // Cleanup helper
  let intervalId: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (intervalId) clearInterval(intervalId);
    systray.kill(false);
    removeTrayPid().finally(() => process.exit(0));
  };

  // Handle quit
  systray.onClick((action) => {
    if (action.item.title === "Quit Tray") cleanup();
  });

  // Poll and update, auto-exit after ~30s idle (0 agents)
  let lastCount = count;
  intervalId = setInterval(async () => {
    try {
      const { count: newCount, tasks: newTasks } = await getRunningAgentCount();

      if (newCount !== lastCount) {
        lastCount = newCount;

        systray.sendAction({
          type: "update-menu",
          menu: {
            icon: ICON_BASE64,
            title: `AY: ${newCount}`,
            tooltip: `agent-yes: ${newCount} running`,
            items: buildMenuItems(newTasks),
          },
        });
      }
    } catch {
      // Ignore polling errors
    }
  }, POLL_INTERVAL);

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
