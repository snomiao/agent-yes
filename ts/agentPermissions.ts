/**
 * The permission posture an agent was actually spawned with — derived once at
 * registration and stamped into the pid record so it can be audited later.
 *
 * Why record it rather than re-derive on read: the global index carries no argv,
 * and the wrapper's own flags (`--robust`, auto-continue) never appear in the
 * CLI's args at all. Without stamping, "was this agent running with permission
 * checks disabled?" is unanswerable after the fact — which is precisely the
 * question an operator looking at a fleet of agents needs answered.
 *
 * Mirrored by `derive_permissions` in rs/src/agentPermissions.rs — keep in sync.
 *
 * Issue #236.
 */

export interface AgentPermissions {
  /**
   * The wrapped CLI got its "yolo" flag — the per-CLI `yesArgs` appended by
   * `-y`/`--yes`, or the same flag passed through directly. This is the one that
   * matters for audit: it disables the CLI's own confirmation gate, so the agent
   * can edit files and run commands with no human in the loop.
   */
  skip_permissions: boolean;
  /** agent-yes `--robust`: restart the CLI automatically when it crashes. */
  robust: boolean;
  /** agent-yes auto-continue: resume the prior session on restart. */
  auto_continue: boolean;
}

/**
 * Flags that disable a CLI's confirmation gate, recognised regardless of what
 * `yesArgs` the config declares.
 *
 * The configured `yesArgs` are the flags `-y` APPENDS; a user is free to pass
 * the same flag directly, and a config that omits `yesArgs` entirely (some CLIs
 * deliberately have none) must not make a genuinely dangerous flag invisible.
 * So the check is the union: configured flags OR any of these.
 */
const DANGEROUS_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--full-auto",
]);

/** `--flag=value` and `--flag value` must compare equal — match on the flag part. */
function flagName(arg: string): string {
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}

export function derivePermissions(opts: {
  /** The args handed to the wrapped CLI (after yesArgs were appended). */
  cliArgs: readonly string[];
  /** The CLI's configured "yolo" flags, if it declares any. */
  yesArgs?: readonly string[];
  robust?: boolean;
  autoContinue?: boolean;
}): AgentPermissions {
  const configured = new Set((opts.yesArgs ?? []).map(flagName).filter(Boolean));
  const skip = opts.cliArgs.some((a) => {
    const name = flagName(a);
    return configured.has(name) || DANGEROUS_FLAGS.has(name);
  });
  return {
    skip_permissions: skip,
    robust: Boolean(opts.robust),
    auto_continue: Boolean(opts.autoContinue),
  };
}

/**
 * One-word posture for a badge. `skip` is the only one that changes what the
 * agent is ALLOWED to do; the wrapper flags change only how it recovers, so
 * they never soften the label.
 */
export function permissionBadge(p: AgentPermissions | null | undefined): "skip" | "prompt" | null {
  if (!p) return null;
  return p.skip_permissions ? "skip" : "prompt";
}
