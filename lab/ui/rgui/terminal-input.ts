export type InputReply = { ok: boolean; text: string };

/** Serialize batches while coalescing every key that arrives in flight. */
export class OrderedInputQueue {
  private pending = "";
  private running = false;
  private scheduled = false;

  constructor(
    private readonly send: (data: string) => Promise<InputReply>,
    private readonly onError: (reply: InputReply) => void,
  ) {}

  push(data: string): void {
    this.pending += data;
    if (this.running || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.running || !this.pending) return;
    this.running = true;
    const batch = this.pending;
    this.pending = "";
    try {
      const reply = await this.send(batch);
      if (!reply.ok) this.onError(reply);
    } catch (error) {
      this.onError({ ok: false, text: String(error) });
    } finally {
      this.running = false;
      if (this.pending) void this.flush();
    }
  }
}

type PredictedOp = { kind: "print"; value: string } | { kind: "backspace" };
const ALT_ON = /\x1b\[\?(?:47|1047|1049)h/;
const ALT_OFF = /\x1b\[\?(?:47|1047|1049)l/;
const DYNAMIC_CONTROL = /\x1b(?:\[[0-9;?]*[ABCDEFGHJKSTfhl]|[78])/;
const QUIET_MS = 250;
const DYNAMIC_COOLDOWN_MS = 1500;

/** Conservative local echo for a quiet primary-screen prompt. */
export class PredictiveEcho {
  private alternate = false;
  private seenOutput = false;
  private lastOutputAt = 0;
  private dynamicUntil = 0;
  private readonly predicted: PredictedOp[] = [];

  observeOutput(data: string, now = performance.now()): string {
    this.seenOutput = true;
    this.lastOutputAt = now;
    if (ALT_ON.test(data)) this.alternate = true;
    if (ALT_OFF.test(data)) this.alternate = false;
    if (DYNAMIC_CONTROL.test(data)) this.dynamicUntil = now + DYNAMIC_COOLDOWN_MS;
    return this.reconcile(data);
  }

  tryInput(
    data: string,
    write: (data: string) => void,
    options: { now?: number; composing?: boolean; alternate?: boolean } = {},
  ): boolean {
    const now = options.now ?? performance.now();
    if (
      options.composing ||
      options.alternate ||
      this.alternate ||
      !this.seenOutput ||
      now - this.lastOutputAt < QUIET_MS ||
      now < this.dynamicUntil ||
      this.predicted.length >= 32
    )
      return false;
    if (/^[\x20-\x7e]$/.test(data)) {
      this.predicted.push({ kind: "print", value: data });
      write(data);
      return true;
    }
    if ((data === "\x7f" || data === "\b") && this.predicted.at(-1)?.kind === "print") {
      this.predicted.push({ kind: "backspace" });
      write("\b \b");
      return true;
    }
    return false;
  }

  private reconcile(data: string): string {
    let rest = data;
    while (this.predicted.length && rest) {
      const op = this.predicted[0];
      if (op.kind === "print") {
        if (!rest.startsWith(op.value)) break;
        rest = rest.slice(op.value.length);
      } else if (rest.startsWith("\b \b")) {
        rest = rest.slice(3);
      } else if (rest[0] === "\b" || rest[0] === "\x7f") {
        rest = rest.slice(1);
      } else {
        break;
      }
      this.predicted.shift();
    }
    if (this.predicted.length && rest) this.predicted.length = 0;
    return rest;
  }
}
