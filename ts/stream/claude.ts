import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AyEvent, StreamAdapter } from "./types.ts";

export function userMessage(text: string, id: string = randomUUID()): string {
  return (
    JSON.stringify({ type: "user", uuid: id, message: { role: "user", content: text } }) + "\n"
  );
}

/** Claude's SDK stdio protocol; unknown notifications are intentionally ignored. */
export class ClaudeAdapter implements StreamAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private turn = 0;
  private active = false;
  private receipts = new Set<string>();
  private requests = new Map<string, unknown>();

  spawn(opts: Parameters<StreamAdapter["spawn"]>[0]): ChildProcessWithoutNullStreams {
    const args = [...opts.args];
    if (opts.resumeId) args.push("--resume", opts.resumeId);
    this.child = spawn(opts.binary ?? "claude", args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    return this.child;
  }

  send(msg: string, id: string = randomUUID()): string {
    if (!this.child?.stdin.writable) throw new Error("Claude stream is not writable");
    this.child.stdin.write(userMessage(msg, id));
    return id;
  }

  async interrupt(): Promise<void> {
    if (!this.child?.stdin.writable) throw new Error("Claude stream is not writable");
    this.child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: randomUUID(),
        request: { subtype: "interrupt" },
      }) + "\n",
    );
  }

  answer(reqId: string, choice: string): void {
    const input = this.requests.get(reqId);
    if (input === undefined) throw new Error("Unknown Claude permission request");
    this.requests.delete(reqId);
    this.child?.stdin.write(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: reqId,
          response:
            choice === "allow"
              ? { behavior: "allow", updatedInput: input }
              : { behavior: "deny", message: choice },
        },
      }) + "\n",
    );
  }

  parse(line: string): AyEvent[] {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return [{ type: "error", message: "Invalid Claude stream JSON", fatal: false }];
    }
    if (!d || typeof d !== "object") return [];
    const events: AyEvent[] = [];
    const start = () => {
      if (!this.active) {
        this.active = true;
        events.push({ type: "turn_start", turn: ++this.turn, ts: Date.now() });
      }
    };
    if (d.type === "system" && d.subtype === "init" && typeof d.session_id === "string") {
      events.push({ type: "session", sessionId: d.session_id, model: d.model });
    }
    if (d.type === "user") {
      const content = d.message?.content;
      // Replay user messages carry the original uuid. Tool-result user messages do not represent a new turn.
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b: any) => b.type === "text")
                .map((b: any) => b.text)
                .join("\n")
            : "";
      if (text && typeof d.uuid === "string" && !this.receipts.has(d.uuid)) {
        this.receipts.add(d.uuid);
        start();
        events.push({ type: "user", id: d.uuid, text });
      }
      if (Array.isArray(content))
        for (const b of content) {
          if (b.type === "tool_result")
            events.push({
              type: "tool_result",
              id: b.tool_use_id,
              ok: !b.is_error,
              summary: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
            });
        }
    }
    if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      start();
      for (const b of d.message.content) {
        if (b.type === "text" && typeof b.text === "string")
          events.push({ type: "text", text: b.text });
        if (b.type === "tool_use")
          events.push({ type: "tool_call", id: b.id, name: b.name, input: b.input });
      }
      if (d.error) events.push({ type: "error", message: String(d.error), fatal: false });
    }
    if (d.type === "control_request" && d.request?.subtype === "can_use_tool") {
      const r = d.request;
      this.requests.set(d.request_id, r.input);
      if (r.tool_name === "AskUserQuestion") {
        const questions = r.input?.questions ?? [];
        events.push({
          type: "needs_input",
          reqId: d.request_id,
          question: questions.map((q: any) => q.question).join("\n"),
          options: questions.flatMap((q: any) => (q.options ?? []).map((o: any) => o.label)),
        });
      } else
        events.push({
          type: "needs_permission",
          reqId: d.request_id,
          tool: r.tool_name,
          input: r.input,
          options: ["allow", "deny"],
        });
    }
    if (d.type === "result") {
      start();
      events.push({
        type: "turn_end",
        turn: this.turn,
        costUsd: typeof d.total_cost_usd === "number" ? d.total_cost_usd : undefined,
        usage: d.usage
          ? {
              inputTokens: d.usage.input_tokens ?? 0,
              outputTokens: d.usage.output_tokens ?? 0,
              cacheReadTokens: d.usage.cache_read_input_tokens,
              cacheCreationTokens: d.usage.cache_creation_input_tokens,
            }
          : undefined,
        stopReason: d.stop_reason ?? d.subtype,
      });
      this.active = false;
      if (d.is_error)
        events.push({
          type: "error",
          message: (d.errors ?? [d.result ?? d.subtype]).join("\n"),
          fatal: false,
        });
    }
    return events;
  }
}
