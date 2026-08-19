#!/usr/bin/env bun
import { watch } from "fs";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const cargo = path.join(root, "rs", "Cargo.toml");
const help = process.argv.includes("-h") || process.argv.includes("--help");

if (help) {
  console.log(`Usage: bun run dev:ayrs [-- <ayrs serve args>]

Incrementally rebuilds the debug ayrs binary and restarts it on Rust changes.
Default: serve --port 0

Examples:
  bun run dev:ayrs
  bun run dev:ayrs -- --webrtc --sighost s.agent-yes.com --port 0

Stop the installed ayrs service before using --webrtc with its persisted room.`);
  process.exit(0);
}

const separator = process.argv.indexOf("--");
const serveArgs =
  separator >= 0 && process.argv.length > separator + 1
    ? process.argv.slice(separator + 1)
    : ["--port", "0"];

let child: ReturnType<typeof Bun.spawn> | undefined;
let building = false;
let queued = false;
let debounce: ReturnType<typeof setTimeout> | undefined;

async function stopChild() {
  if (!child) return;
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(1500)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  child = undefined;
}

async function rebuild() {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  await stopChild();
  console.log("[dev:ayrs] incremental build");
  const build = Bun.spawn(
    ["cargo", "build", "--manifest-path", cargo, "--bin", "ayrs"],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const code = await build.exited;
  if (code === 0) {
    console.log(`[dev:ayrs] restart: serve ${serveArgs.join(" ")}`);
    child = Bun.spawn(
      [
        path.join(
          root,
          "rs",
          "target",
          "debug",
          process.platform === "win32" ? "ayrs.exe" : "ayrs",
        ),
        "serve",
        ...serveArgs,
      ],
      { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    );
  } else {
    console.error(
      `[dev:ayrs] build failed (${code}); waiting for the next change`,
    );
  }
  building = false;
  if (queued) {
    queued = false;
    void rebuild();
  }
}

function changed() {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => void rebuild(), 120);
}

const watchers = [
  watch(path.join(root, "rs", "src"), { recursive: true }, changed),
  watch(path.join(root, "rs", "Cargo.toml"), changed),
  watch(path.join(root, "rs", "Cargo.lock"), changed),
];

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    for (const watcher of watchers) watcher.close();
    await stopChild();
    process.exit(0);
  });
}

await rebuild();
await new Promise(() => {});
