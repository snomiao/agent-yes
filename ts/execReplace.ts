// Replace the running Bun process with the native binary instead of keeping the
// JS launcher resident as its parent. Every lane used to pay ~11 MB for a bun
// process that did nothing but forward signals and the exit code; execve makes
// the native binary BE this process (same pid, same stdio and terminal).
//
// Unix + Bun only. Returns false (and the caller spawns as before) when exec is
// unsupported or fails; on success it never returns.

import { dlopen, FFIType, ptr } from "bun:ffi";

const LIBC = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";

function cstr(s: string): Buffer {
  return Buffer.from(`${s}\0`);
}

/** NUL-terminated array of C-string pointers; keep `keep` alive until the call. */
function cArray(items: string[], keep: Buffer[]): BigUint64Array {
  const arr = new BigUint64Array(items.length + 1);
  items.forEach((s, i) => {
    const b = cstr(s);
    keep.push(b);
    arr[i] = BigInt(ptr(b));
  });
  return arr;
}

export function canExecReplace(): boolean {
  return (
    typeof Bun !== "undefined" &&
    (process.platform === "darwin" || process.platform === "linux") &&
    process.env.AGENT_YES_NO_EXEC !== "1"
  );
}

export function execReplace(
  file: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!canExecReplace()) return false;
  try {
    const { symbols } = dlopen(LIBC, {
      execve: { args: ["ptr", "ptr", "ptr"], returns: FFIType.i32 },
    });
    const keep: Buffer[] = [];
    const path = cstr(file);
    keep.push(path);
    const argv = cArray([file, ...args], keep);
    const envp = cArray(
      Object.entries(env)
        .filter((e): e is [string, string] => e[1] !== undefined)
        .map(([k, v]) => `${k}=${v}`),
      keep,
    );
    // Only returns on failure (-1); on success this process image is gone.
    symbols.execve(ptr(path), ptr(argv), ptr(envp));
  } catch {
    // dlopen/FFI unavailable: fall through to the spawn path
  }
  return false;
}
