import { getRunningAgentCount, type Task } from "./runningLock.ts";

const POLL_INTERVAL = 2000;

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

export async function startTray(): Promise<void> {
  // Only macOS and Windows have proper tray support
  if (process.platform !== "darwin" && process.platform !== "win32") {
    console.error("Tray icon is only supported on macOS and Windows.");
    return;
  }

  let SysTray: typeof import("systray2").default;
  try {
    SysTray = (await import("systray2")).default;
  } catch {
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

  // Handle quit
  systray.onClick((action) => {
    if (action.item.title === "Quit Tray") {
      systray.kill(false);
      process.exit(0);
    }
  });

  // Poll and update
  let lastCount = count;
  const interval = setInterval(async () => {
    try {
      const { count: newCount, tasks: newTasks } = await getRunningAgentCount();

      if (newCount !== lastCount) {
        lastCount = newCount;

        // Update title and tooltip
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

  // Cleanup on exit
  process.on("SIGINT", () => {
    clearInterval(interval);
    systray.kill(false);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(interval);
    systray.kill(false);
    process.exit(0);
  });
}
