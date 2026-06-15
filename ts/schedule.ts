import { createHash } from "node:crypto";
import { SUPPORTED_CLIS } from "./SUPPORTED_CLIS.ts";
import { resolveSpawnCwd } from "./workspaceConfig.ts";

// `ay schedule` — run an agent on a recurring schedule via oxmgr's cron support.
// A scheduled job runs once immediately AND on every cron tick (with
// --restart never so it isn't relaunched merely on exit), and — like the share
// daemon — survives reboot once oxmgr's system service is installed.

const SCHED_PREFIX = "ay-sched-";

/** `HH:MM` → a daily cron; otherwise a raw 5-field cron passes through. null if neither. */
export function toCron(spec: string): string | null {
  const s = spec.trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const h = Number(hm[1]),
      m = Number(hm[2]);
    return h < 24 && m < 60 ? `${m} ${h} * * *` : null;
  }
  return /^\S+(\s+\S+){4}$/.test(s) ? s : null; // exactly 5 whitespace-separated fields
}

/** Single-quote for oxmgr's shell-style command parsing (verified: it respects quotes). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function schedName(explicit: string | undefined, cli: string, key: string): string {
  if (explicit) return explicit.startsWith(SCHED_PREFIX) ? explicit : SCHED_PREFIX + explicit;
  return SCHED_PREFIX + cli + "-" + createHash("sha1").update(key).digest("hex").slice(0, 6);
}

async function run(cmd: string[], capture = false): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const out = capture ? await new Response(p.stdout).text() : "";
  return { code: (await p.exited) ?? 1, out };
}

export async function cmdSchedule(rest: string[]): Promise<number> {
  const oxmgrBin = Bun.which("oxmgr");
  if (!oxmgrBin) {
    process.stderr.write(
      "ay schedule: oxmgr not found\n" +
        "  install with:  cargo install oxmgr\n" +
        "             or: bun add -g oxmgr\n",
    );
    return 1;
  }

  const sub = rest[0];

  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(
      `Usage:\n` +
        `  ay schedule <when> <cli> [--cwd DIR] [--name N] [-- <prompt>]\n` +
        `                                    schedule a recurring agent\n` +
        `  ay schedule list                  list scheduled agents\n` +
        `  ay schedule remove <name>         remove one\n\n` +
        `<when> is a daily HH:MM (e.g. 10:00) or a 5-field cron ("0 10 * * *").\n` +
        `The agent runs once now and then on every tick, and survives reboot.\n\n` +
        `Example — a 10am daily QA pass:\n` +
        `  ay schedule 10:00 claude --cwd ~/ws/product -- "run a full QA pass and write a report"\n`,
    );
    return 0;
  }

  if (sub === "list" || sub === "ls") {
    // oxmgr lists everything; scheduled agents are the ay-sched-* rows.
    process.stdout.write(`scheduled agents are named '${SCHED_PREFIX}*':\n`);
    return (await run([oxmgrBin, "list"])).code;
  }

  if (sub === "remove" || sub === "rm" || sub === "delete") {
    const name = rest[1];
    if (!name) {
      process.stderr.write("usage: ay schedule remove <name>\n");
      return 1;
    }
    const full = name.startsWith(SCHED_PREFIX) ? name : SCHED_PREFIX + name;
    return (await run([oxmgrBin, "delete", full])).code;
  }

  // ay schedule <when> <cli> [--cwd DIR] [--name N] [-- <prompt>]
  const dashIdx = rest.indexOf("--");
  const head = dashIdx >= 0 ? rest.slice(0, dashIdx) : rest;
  const prompt = dashIdx >= 0 ? rest.slice(dashIdx + 1).join(" ") : "";

  let nameFlag: string | undefined;
  let cwdFlag: string | undefined;
  const pos: string[] = [];
  for (let i = 0; i < head.length; i++) {
    if (head[i] === "--name") nameFlag = head[++i];
    else if (head[i] === "--cwd") cwdFlag = head[++i];
    else pos.push(head[i]!);
  }

  const [when, cli] = pos;
  if (!when || !cli) {
    process.stderr.write("usage: ay schedule <when> <cli> [-- <prompt>]\n");
    return 1;
  }
  const cron = toCron(when);
  if (!cron) {
    process.stderr.write(`ay schedule: bad <when> "${when}" — use HH:MM or a 5-field cron\n`);
    return 1;
  }
  if (!SUPPORTED_CLIS.includes(cli as never)) {
    process.stderr.write(`ay schedule: unsupported cli "${cli}"\n`);
    return 1;
  }

  const cwd = resolveSpawnCwd(cwdFlag);
  // Absolute interpreter + bin: oxmgr's daemon PATH may lack ~/.bun/bin.
  const ayBin = Bun.which("ay");
  const ayInvoke = ayBin ? `${process.execPath} ${ayBin}` : "ay";
  const agentCmd = `${ayInvoke} ${cli}${prompt ? ` -- ${shellQuote(prompt)}` : ""}`;
  const name = schedName(nameFlag, cli, cron + "\0" + prompt + "\0" + cwd);

  const { code } = await run([
    oxmgrBin,
    "start",
    agentCmd,
    "--name",
    name,
    "--cwd",
    cwd,
    "--restart",
    "never", // only (re)launched by the cron tick, not on plain exit
    "--cron-restart",
    cron,
  ]);
  if (code !== 0) return code;

  // Persist across reboots (idempotent; same wrapper the daemon install uses).
  // Best-effort: the schedule is already registered, so don't fail the command if
  // boot registration can't be done here — just report it honestly.
  const onBoot = (await run([oxmgrBin, "service", "install"], true)).code === 0;

  process.stdout.write(
    `\nscheduled '${name}'\n` +
      `  ${cli}${prompt ? ` -- "${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}"` : ""}\n` +
      `  when: ${cron}   cwd: ${cwd}\n` +
      (onBoot
        ? `  runs now and on every tick; survives reboot.\n`
        : `  runs now and on every tick.\n` +
          `  start-on-boot: not registered — run \`oxmgr service install\` to enable\n`) +
      `\n  ay schedule list                     # all scheduled agents\n` +
      `  ay schedule remove ${name.slice(SCHED_PREFIX.length)}\n`,
  );
  return 0;
}
