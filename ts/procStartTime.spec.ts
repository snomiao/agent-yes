import { describe, expect, it } from "vitest";
import { osProcessStartToken, osStartTokenMismatch, parseLinuxStartTime } from "./procStartTime.ts";

// Field 22 of /proc/<pid>/stat. After the comm, fields 3.. are: state ppid pgrp
// session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime
// cstime priority nice num_threads itrealvalue starttime — so `starttime` sits at
// index 19 of everything following the last ')'.
const after = (starttime: string) =>
  ["S", "1", "1", "1", "0", "-1", "4194304"]
    .concat(Array(12).fill("0")) // minflt..itrealvalue
    .concat([starttime])
    .join(" ");

describe("parseLinuxStartTime", () => {
  it("reads starttime from a normal stat line", () => {
    expect(parseLinuxStartTime(`1234 (bash) ${after("987654")}`)).toBe("987654");
  });

  it("survives a comm containing spaces and parentheses", () => {
    // The whole reason we parse after the LAST ')': naive splitting mis-indexes
    // every field once comm has spaces/parens in it.
    expect(parseLinuxStartTime(`1234 (my prog (v2)) ${after("42")}`)).toBe("42");
  });

  it("returns null for a line with no comm terminator", () => {
    expect(parseLinuxStartTime("1234 bash S 1 1")).toBeNull();
  });

  it("returns null when the field is missing or not numeric", () => {
    expect(parseLinuxStartTime("1234 (bash) S 1 1")).toBeNull();
    expect(parseLinuxStartTime(`1234 (bash) ${after("not-a-number")}`)).toBeNull();
  });
});

describe("osProcessStartToken", () => {
  const stat = `7 (agent) ${after("555")}`;

  it("uses /proc on linux", () => {
    expect(
      osProcessStartToken(7, { platform: "linux", readProcStat: () => stat }),
    ).toBe("555");
  });

  it("uses ps lstart on darwin/bsd", () => {
    for (const platform of ["darwin", "freebsd", "openbsd"]) {
      expect(
        osProcessStartToken(7, { platform, readPsLstart: () => " Sun Jul 27 06:00:00 2026 " }),
      ).toBe("Sun Jul 27 06:00:00 2026");
    }
  });

  it("has no opinion on windows", () => {
    expect(osProcessStartToken(7, { platform: "win32" })).toBeNull();
  });

  it("has no opinion when the reader cannot answer", () => {
    expect(osProcessStartToken(7, { platform: "linux", readProcStat: () => null })).toBeNull();
    expect(osProcessStartToken(7, { platform: "darwin", readPsLstart: () => null })).toBeNull();
  });

  it("rejects a non-positive pid without consulting the OS", () => {
    let called = false;
    const readProcStat = () => {
      called = true;
      return stat;
    };
    expect(osProcessStartToken(0, { platform: "linux", readProcStat })).toBeNull();
    expect(osProcessStartToken(-1, { platform: "linux", readProcStat })).toBeNull();
    expect(osProcessStartToken(NaN, { platform: "linux", readProcStat })).toBeNull();
    expect(called).toBe(false);
  });

  // Forcing the platform while leaving the DEFAULT readers in place exercises the
  // real OS readers on every host: /proc simply isn't there on macOS (the same
  // fail-soft path a hardened container hits), and `ps -o lstart=` exists on
  // Linux too. Both must answer, never throw.
  it("fails soft when the real /proc reader has nothing to read", () => {
    const token = osProcessStartToken(process.pid, { platform: "linux" });
    expect(token === null || /^\d+$/.test(token)).toBe(true);
  });

  it("fails soft when the real ps reader is unavailable", () => {
    const token = osProcessStartToken(process.pid, { platform: "darwin" });
    expect(token === null || token.length > 0).toBe(true);
  });

  it("answers for the real current process on a supported platform", () => {
    const token = osProcessStartToken(process.pid);
    if (process.platform === "linux" || process.platform === "darwin") {
      expect(typeof token).toBe("string");
      expect(token).not.toBe("");
      // Stable across reads — it identifies WHEN the process started.
      expect(osProcessStartToken(process.pid)).toBe(token);
    } else {
      expect(token).toBeNull();
    }
  });
});

describe("osStartTokenMismatch", () => {
  it("flags only a positive disagreement", () => {
    expect(osStartTokenMismatch("111", "222")).toBe(true);
  });

  it("accepts agreement", () => {
    expect(osStartTokenMismatch("111", "111")).toBe(false);
  });

  // Fail-OPEN by design: this guard is layered on top of pid-liveness and
  // heartbeat freshness, so "cannot tell" must never become "assume recycled" —
  // that would break every platform without a reader.
  it("has no opinion when either side is absent", () => {
    expect(osStartTokenMismatch(undefined, "222")).toBe(false);
    expect(osStartTokenMismatch(null, "222")).toBe(false);
    expect(osStartTokenMismatch("", "222")).toBe(false);
    expect(osStartTokenMismatch("111", null)).toBe(false);
    expect(osStartTokenMismatch(undefined, null)).toBe(false);
  });
});
