import type { AyEvent } from "./types.ts";

export function renderEvent(event: AyEvent): string {
  switch (event.type) {
    case "turn_start":
      return `── turn ${event.turn} ──\n`;
    case "user":
      return `user: ${event.text}\n`;
    case "text":
      return `assistant: ${event.text}\n`;
    case "tool_call":
      return `● ${event.name}(${JSON.stringify(event.input)})\n`;
    case "tool_result":
      return `  ${event.ok ? "✓" : "✗"} ${event.summary}\n`;
    case "needs_permission":
      return `permission: ${event.tool}(${JSON.stringify(event.input)})\n`;
    case "needs_input":
      return `question: ${event.question}\n`;
    case "turn_end":
      return `── end${event.costUsd === undefined ? "" : ` · $${event.costUsd.toFixed(4)}`}${event.usage ? ` · ${event.usage.inputTokens} in / ${event.usage.outputTokens} out` : ""} ──\n`;
    case "error":
      return `error: ${event.message}\n`;
    case "session":
      return `session: ${event.sessionId}${event.model ? ` (${event.model})` : ""}\n`;
  }
}
