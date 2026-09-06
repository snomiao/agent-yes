import { describe, expect, it } from "bun:test";
import { pidOwnershipVerdict } from "./senderAncestry.ts";

// The verdict cmdRestart consults before SIGKILL. What matters here is not the
// arithmetic — that is ageMatchesRegistration's, tested with the send path —
// but that "cannot establish" stays a THIRD answer. Collapsing it into
// "reused" would read as caution and act as removal: win32 has no process
// table reader, so every force-kill there would refuse forever.
describe("restart must not SIGKILL a recycled pid", () => {
  const now = 1_000_000_000;
  const hourOld = now - 3600_000;

  it("ours: the process is as old as the row that registered it", () => {
    expect(pidOwnershipVerdict(3600, hourOld, now)).toBe("ours");
  });

  it("reused: the process is younger than the row, so it cannot be the agent", () => {
    // Shape of the live case: a row surviving a reboot whose pid had been
    // handed to an unrelated system process. Nothing in the code was declining
    // to kill it — EPERM was, and only because the owner differed. A same-user
    // recycled pid would have been killed.
    expect(pidOwnershipVerdict(60, now - 89 * 86400_000, now)).toBe("reused");
  });

  it("unknown when there is no process table — NOT reused", () => {
    // What `table?.get(pid)?.ageSecs` yields on win32, where readAncestryTable
    // returns null by design, and on a transient ps failure.
    expect(pidOwnershipVerdict(undefined, hourOld, now)).toBe("unknown");
  });

  it("unknown when the row carries no registration time — NOT reused", () => {
    expect(pidOwnershipVerdict(3600, undefined, now)).toBe("unknown");
  });

  it("does not read ordinary registration lag as reuse", () => {
    // A process is a moment older than the row recording it; if that read as
    // reuse, restart would stop force-killing healthy agents.
    expect(pidOwnershipVerdict(3595, hourOld, now)).toBe("ours");
  });
});
