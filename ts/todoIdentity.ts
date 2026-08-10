/**
 * "Who am I" for `ay todo`, so a task's owner is a value the rest of the
 * engine can actually reason about.
 *
 * `TodoRecord.owner` is deliberately opaque — a human handle OR an agent's
 * identifier — but `todoAutomation.ts` gives one specific string special
 * meaning: `deadOwnerAgent()` looks the owner up in the global agent index by
 * `agent_id`, and orphans the task when that agent has exited. An owner that
 * is anything else (a human name, a bare pid, a hostname) simply never matches
 * a record, and is therefore treated as a human owner and never orphaned.
 *
 * That asymmetry is the reason this module refuses to guess. Writing "some
 * plausible identifier" for an agent owner would not fail loudly; it would
 * produce a task that LOOKS assigned to an agent and silently opts out of
 * orphan recovery forever — the one automation that exists to notice its owner
 * died. So `resolveSelfAgentId` returns the registry's own `agent_id` or
 * nothing, and the CLI turns "nothing" into an error the caller can read.
 *
 * Resolution mirrors `resolveSender()` in `subcommands.ts`: the wrapper
 * injects its own pid as `AGENT_YES_PID` into the agent's environment (the
 * agent's own pid is not knowable until after spawn), so the env value maps
 * back to a record via `wrapper_pid`, falling back to `pid` for a process that
 * IS the wrapper.
 */

import { readGlobalPids, type GlobalPidRecord } from "./globalPidIndex.ts";

/** The literal an owner argument uses to mean "the agent running this command". */
export const SELF_OWNER = "me";

/** The literal that explicitly means "no owner" — distinct from omitting the flag, which defaults to self. */
export const NO_OWNER = "none";

export interface SelfIdentity {
  agentId: string;
  pid: number;
  cwd: string;
  title?: string | null;
}

export type PidReader = () => Promise<GlobalPidRecord[]>;

/**
 * The calling agent's registry record, or `null` when this is a human shell
 * (no `AGENT_YES_PID`) or the agent is not registered under a stable id.
 *
 * The `agent_id`-less case returns `null` rather than falling back to the pid:
 * a pid is not what `reconcileTodos` compares against, so storing one would be
 * indistinguishable from a human owner to every downstream consumer while
 * looking, to a reader, like a working agent assignment.
 */
export async function resolveSelf(
  env: Record<string, string | undefined> = process.env,
  readPids: PidReader = () => readGlobalPids(),
): Promise<SelfIdentity | null> {
  const envPid = env.AGENT_YES_PID ? Number(env.AGENT_YES_PID) : null;
  if (!envPid || Number.isNaN(envPid)) return null;
  const recs = await readPids();
  const rec = recs.find((r) => r.wrapper_pid === envPid) ?? recs.find((r) => r.pid === envPid);
  if (!rec?.agent_id) return null;
  return { agentId: rec.agent_id, pid: rec.pid, cwd: rec.cwd, title: rec.title };
}

/** Live-ness of an owner string, for read-side views. `unknown` covers human owners and agents that never registered. */
export type OwnerLiveness = "active" | "idle" | "exited" | "unknown";

/** Look an owner up in an agent snapshot. Same `agent_id` matching `deadOwnerAgent()` uses, so the two never disagree about who is an agent. */
export function ownerLiveness(
  owner: string | undefined,
  agents: Pick<GlobalPidRecord, "agent_id" | "status">[],
): OwnerLiveness {
  if (!owner) return "unknown";
  return agents.find((a) => a.agent_id === owner)?.status ?? "unknown";
}
