/**
 * Structured result envelope — P4 of the orchestrator-observability work.
 *
 * A fan-out parent that spawned a sub-agent wants its *outcome* (branch, commit
 * SHAs, changed files, status, blockers, a summary) as machine-readable data,
 * not by grepping `ay tail`. This is the agent-yes analog of an in-harness
 * Agent tool's `<result>` block. The sub-agent deposits one JSON envelope when
 * it finishes; the parent pulls it with `ay result <keyword>`.
 *
 * Why a PERSISTED file, not a query-time screen scrape (the model that
 * `needs_input`/activity use): a completion record is read AFTER the agent is
 * done — exactly when its rendered screen is gone and its log may be reaped. It
 * must outlive the process, so it is written once to
 * `$AGENT_YES_HOME/results/<pid>.json` and read back verbatim. It is keyed by
 * the wrapper pid the agent already knows via the injected `AGENT_YES_PID` env
 * var, so depositing needs no new spawn-time wiring in either runtime.
 *
 * This module is the pure, fs-free core (path math + input normalization) so it
 * is trivially unit-testable, mirroring `lsWatch.ts` / `needsInput.ts`. The fs
 * read/write + CLI live in `subcommands.ts` (`cmdResult`).
 */

import path from "path";
import { agentYesHome } from "./agentYesHome.ts";

/**
 * The on-disk shape: agent payload (`result`) plus the minimal metadata a
 * consumer needs to correlate it. `result` is whatever JSON the agent emitted —
 * we don't enforce a schema, only suggest one (see `ResultPayload`).
 */
export interface StoredResult {
  pid: number;
  written_at: number;
  result: unknown;
}

/**
 * The SUGGESTED envelope an agent emits. None of it is required or validated —
 * it documents the convention an orchestrator can rely on when it controls the
 * sub-agent's prompt. Extra fields pass through untouched.
 */
export interface ResultPayload {
  /** Operator-facing rollup: "done", "blocked", "failed", or free text. */
  status?: string;
  /** One-line (or short) summary of what was accomplished. */
  summary?: string;
  /** Git branch the work landed on. */
  branch?: string;
  /** Commit SHAs produced, oldest→newest. */
  commits?: string[];
  /** Paths touched (relative to the repo root). */
  files?: string[];
  /** Anything that blocked completion / needs the parent's attention. */
  blockers?: string[];
  [k: string]: unknown;
}

/** Directory holding the per-pid result files. */
export function resultsDir(): string {
  return path.join(agentYesHome(), "results");
}

/** Absolute path of one agent's result envelope. */
export function resultPath(pid: number): string {
  return path.join(resultsDir(), `${pid}.json`);
}

/**
 * Coerce raw write-side input into an envelope payload. If it parses as JSON we
 * keep it as-is (object, array, or scalar — the agent owns the shape). If it
 * does NOT parse, we don't reject: a bare string is a perfectly good summary, so
 * we wrap it as `{ summary }`. Empty / whitespace-only input is an error the
 * caller should surface (returns null).
 */
export function normalizeEnvelope(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return { summary: trimmed } satisfies ResultPayload;
  }
}

/** Wrap a normalized payload with correlation metadata for persistence. */
export function buildStoredResult(pid: number, result: unknown, writtenAt: number): StoredResult {
  return { pid, written_at: writtenAt, result };
}
