import { dlopen } from "bun:ffi";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const k = dlopen("kernel32.dll", {
  GetStdHandle: { args: ["i32"], returns: "ptr" },
  GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
});
const { ptr } = await import("bun:ffi");
const input = k.symbols.GetStdHandle(-10);
const readMode = () => {
  const mode = new Uint32Array(1);
  if (!k.symbols.GetConsoleMode(input, ptr(mode))) throw new Error("GetConsoleMode failed");
  return mode[0];
};
const before = readMode();
const child = spawnSync(process.argv[2], process.argv.slice(3), { stdio: "inherit" });
writeFileSync(process.env.MODE_LOG!, JSON.stringify({ before, after: readMode() }));
process.exit(child.status ?? 1);
