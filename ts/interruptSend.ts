export type InterruptState = "busy" | "idle" | "permission" | "unknown";

/** Permission prompts take precedence over lingering busy chrome. */
export function interruptScreenState(
  cli: string,
  lines: string[],
  cfg: { working?: RegExp[]; needsInput?: RegExp[] },
): InterruptState {
  const text = lines.join("\n");
  const matches = (patterns: RegExp[] = []) =>
    patterns.some((re) => new RegExp(re.source, re.flags.replace(/[gy]/g, "")).test(text));
  if (
    matches(cfg.needsInput) ||
    lines.some((line) =>
      /^\s*[│┃]?\s*(?:[❯›>]\s*\d+\.\s|.*\bctrl\+k\s+approve\b|.*\bneeds approval\b)/i.test(line),
    )
  )
    return "permission";
  if (matches(cfg.working)) return "busy";
  const prompt = cli === "agy" ? /^\s*>($|\s)/u : /^\s*[❯›]($|\s)/u;
  return lines.some((line) => prompt.test(line)) ? "idle" : "unknown";
}

export type InterruptResult = "interrupted" | "idle" | "permission" | "unsupported" | "unknown";

/** Caller holds the input lock through cancellation, idle detection and delivery. */
export async function interruptBeforeSend(
  cli: string,
  deps: {
    readState: () => Promise<InterruptState>;
    write: (code: string) => Promise<void>;
    sleep: (ms: number) => Promise<void>;
  },
  timeoutMs = 8000,
): Promise<InterruptResult> {
  if (!["claude", "codex", "agy"].includes(cli)) return "unsupported";
  const before = await deps.readState();
  if (before !== "busy") return before;
  // One Escape cancels the turn. Never send Ctrl+C (which can quit a CLI),
  // Alt+M (which submits existing input), or a second Escape at an idle draft.
  await deps.write("\x1b");
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 100) {
    await deps.sleep(100);
    const state = await deps.readState();
    if (state === "idle") return "interrupted";
    if (state === "permission") return "permission";
  }
  throw new Error(
    "ay send: --interrupt timed out waiting for the idle prompt; message was not sent",
  );
}
