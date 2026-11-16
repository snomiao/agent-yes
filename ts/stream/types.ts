import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type AyEvent =
  | { type: "turn_start"; turn: number; ts: number }
  | { type: "user"; id: string; text: string }
  | { type: "text"; text: string; partial?: boolean }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; summary: string }
  | { type: "needs_permission"; reqId: string; tool: string; input: unknown; options: string[] }
  | { type: "needs_input"; reqId: string; question: string; options?: string[] }
  | { type: "turn_end"; turn: number; costUsd?: number; usage?: Usage; stopReason?: string }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "session"; sessionId: string; model?: string };

export interface StreamAdapter {
  spawn(opts: {
    cwd: string;
    args: string[];
    resumeId?: string;
    binary?: string;
    env?: NodeJS.ProcessEnv;
  }): ChildProcessWithoutNullStreams;
  send(msg: string, id?: string): string;
  interrupt(): Promise<void>;
  answer(reqId: string, choice: string): void;
  parse(line: string): AyEvent[];
}
