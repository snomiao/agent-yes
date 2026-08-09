/**
 * Delivery side of the sub-agent→parent ping: turn a `PingDecision` into a
 * message and inject it into the parent's stdin.
 *
 * We deliberately deliver through the real `ay send` subprocess rather than
 * writing the parent's FIFO directly. `ay send` is where the `<ay-msg nonce
 * from …>` attribution wrapper, the paste/submit handling and the durable
 * message log all live; re-implementing any of that here would drift. The cost
 * is one short-lived process per ping, which happens at most a handful of times
 * per agent lifetime.
 *
 * Two flags are load-bearing:
 *   --force    the recency guard ("you must have tailed this target lately")
 *              exists to stop an agent from firing at a target it never looked
 *              at. A child reporting to its own parent is the one relationship
 *              where that guard is pure false-positive.
 *   --no-wait  the wrapper must never block its own PTY loop waiting for the
 *              parent's screen to settle.
 */

import { spawn } from "node:child_process";
import type { PingDecision } from "./parentPing.ts";
import { shortenHome } from "./initMsg.ts";
import { logger } from "./logger.ts";

export interface PingSelf {
  cli: string;
  /** The child AGENT's pid — what the parent will use in `ay tail <pid>`. */
  pid: number;
  cwd: string;
  /** The task this child was spawned with, for a one-line reminder. */
  prompt?: string | null;
  /** Exit code, when the ping reason is "exited". */
  exitCode?: number | null;
}

const HEADLINE: Record<PingDecision["reason"], string> = {
  finished: "looks FINISHED (idle at its prompt, no longer working)",
  stuck: "is STUCK (parked waiting for input / not making progress)",
  exited: "has EXITED",
};

/** Trim to `max` chars on a whitespace boundary where possible. */
function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

/**
 * The report body. Pure so the wording is testable and stable.
 *
 * It is explicitly framed as coming from the WRAPPER, not the agent: the agent
 * itself may have said nothing at all (that is usually why this fires), and a
 * parent that mistakes an automatic ping for the child's considered answer would
 * act on a summary the child never wrote. The tail is included because the whole
 * point is that the parent is not tailing.
 */
export function buildPingBody(
  decision: PingDecision,
  self: PingSelf,
  tail?: string | null,
): string {
  const attempt = decision.attempt > 1 ? ` (reminder #${decision.attempt - 1} — no reply yet)` : "";
  const lines = [
    `<ay-report from ${self.cli} #${self.pid} @ ${shortenHome(self.cwd)}>`,
    `Your sub-agent ${HEADLINE[decision.reason]}${attempt}.`,
    `This is an automatic report from its agent-yes wrapper, not from the agent itself —`,
    `treat the tail below as evidence, not as its answer.`,
  ];
  if (self.prompt) lines.push(`Task it was spawned with: ${clip(self.prompt, 200)}`);
  if (decision.reason === "exited" && self.exitCode != null)
    lines.push(`Exit code: ${self.exitCode}`);
  if (decision.question) lines.push(`It is asking: ${clip(decision.question, 300)}`);
  if (tail?.trim()) {
    lines.push(`Last output:`, clip(tail, 1200));
  }
  lines.push(
    decision.reason === "exited"
      ? `Next: ay result get ${self.pid} | ay cat ${self.pid}`
      : `Next: ay tail ${self.pid} | ay send ${self.pid} "..." | ay exit ${self.pid}`,
    `</ay-report>`,
  );
  return lines.join("\n");
}

/**
 * Argv for the `ay send` that carries `body` to `target`. Re-invokes THIS
 * entrypoint (argv[0] + argv[1]) rather than a bare `ay` on PATH, so a wrapper
 * running from a checkout, a global link, or `npx` all ping through the exact
 * same build they are part of.
 */
export function buildSendArgv(target: string, argv1?: string): { cmd: string; args: string[] } {
  const send = ["send", target, "-", "--force", "--no-wait"];
  if (argv1) return { cmd: process.execPath, args: [argv1, ...send] };
  return { cmd: "ay", args: send };
}

/**
 * Fire one ping. Resolves when the send subprocess exits; never throws — a
 * failed report must not take down the agent it is reporting about.
 *
 * `selfWrapperPid` is stamped as AGENT_YES_PID for the subprocess so `ay send`
 * attributes the message to THIS child. Without it the subprocess would inherit
 * the wrapper's own AGENT_YES_PID — which is the PARENT's wrapper pid — and the
 * parent would receive a message apparently sent by itself.
 */
export async function deliverPing(opts: {
  target: string;
  body: string;
  selfWrapperPid: number;
  timeoutMs?: number;
}): Promise<boolean> {
  const { cmd, args } = buildSendArgv(opts.target, process.argv[1]);
  return await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    try {
      const child = spawn(cmd, args, {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, AGENT_YES_PID: String(opts.selfWrapperPid) },
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(false);
      }, opts.timeoutMs ?? 30_000);
      timer.unref?.();
      child.on("error", (err) => {
        clearTimeout(timer);
        logger.debug(`[parent-ping] send failed: ${err.message}`);
        finish(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.body);
    } catch (err) {
      logger.debug(`[parent-ping] spawn failed: ${(err as Error).message}`);
      finish(false);
    }
  });
}
