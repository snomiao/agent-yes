import { dlopen, ptr } from "bun:ffi";
import { appendFileSync } from "node:fs";
const k = dlopen("kernel32.dll", {
  GetStdHandle: { args: ["i32"], returns: "ptr" },
  SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
  ReadConsoleInputW: { args: ["ptr", "ptr", "u32", "ptr"], returns: "i32" },
});
const input = k.symbols.GetStdHandle(-10);
// Window + mouse + extended input; match a native Windows TUI.
if (!k.symbols.SetConsoleMode(input, 0x98)) throw new Error("SetConsoleMode failed");
process.stdout.write("\x1b[?2004h");
console.log("PROBE_READY");
const event = new Uint8Array(20),
  count = new Uint32Array(1);
for (;;) {
  if (!k.symbols.ReadConsoleInputW(input, ptr(event), 1, ptr(count)))
    throw new Error("ReadConsoleInput failed");
  const v = new DataView(event.buffer);
  if (v.getUint16(0, true) !== 1 && v.getUint16(0, true) !== 2) continue;
  const record =
    v.getUint16(0, true) === 1
      ? {
          type: 1,
          down: v.getInt32(4, true),
          repeat: v.getUint16(8, true),
          vk: v.getUint16(10, true),
          scan: v.getUint16(12, true),
          char: v.getUint16(14, true),
          ctrl: v.getUint32(16, true),
        }
      : {
          type: 2,
          x: v.getInt16(4, true),
          y: v.getInt16(6, true),
          buttons: v.getUint32(8, true),
          ctrl: v.getUint32(12, true),
          flags: v.getUint32(16, true),
        };
  appendFileSync(process.env.PROBE_LOG!, JSON.stringify(record) + "\n");
  if (v.getUint16(0, true) === 1 && v.getUint16(14, true) === 0xe000) break;
}
