/**
 * Resolve which agent CLI a binary invocation implies, from the binary name in
 * argv[1].
 *
 * Every published bin (cy, claude-yes, codex-yes, ay, agent-yes, …) is the SAME
 * cli.ts entry; the binary's *name* is what selects the default agent. A
 * cli-bound alias — `cy` (= claude-yes = "agent-yes claude"), `codex-yes`, … —
 * resolves to that agent; the generic manager entry (`ay` / `agent-yes` / `cli`)
 * resolves to `undefined`. Callers use that `undefined` to tell "the agent-yes
 * manager" apart from "a cli-bound runner alias".
 */

// Short aliases → target CLI. Must match the alias wrappers postbuild.ts emits.
export const CLI_ALIASES: Record<string, string> = { cy: "claude" };

/**
 * The agent CLI implied by argv[1] (cy / claude-yes → "claude", codex-yes →
 * "codex", …), or `undefined` for the generic `ay` / `agent-yes` / `cli` entry.
 */
export function invokedCliName(argv: string[]): string | undefined {
  const base =
    argv[1]
      ?.split(/[/\\]/)
      .at(-1)
      ?.replace(/(\.[jt]s)?$/, "") || "";
  const raw =
    base
      .replace(/^(cli|agent)(-yes)?$/, "")
      .replace(/^ay$/, "") // treat standalone "ay" same as "agent-yes"
      .replace(/-yes$/, "") || undefined;
  return (raw && CLI_ALIASES[raw]) || raw;
}
