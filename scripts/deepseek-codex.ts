#!/usr/bin/env bun

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

type Json = Record<string, any>;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load .env.local ourselves (bun only auto-loads it from the *current working
// directory*, so `ay ds` from an unrelated cwd would miss the token). Sources,
// in ascending precedence: ~/.agent-yes/.env.local (global) → <repo-root>/.env.local
// (local checkout) → the ambient environment, which always wins.
function loadLocalEnv(): void {
  const paths = [join(homedir(), ".agent-yes", ".env.local"), join(root, ".env.local")];
  for (const path of paths) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadLocalEnv();

const apiKey = process.env.DEEPSEEK_API_KEY;
const upstream = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";

if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is missing from .env.local");
  process.exit(2);
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
        return part.text || "";
      }
      return "";
    })
    .join("");
}

// DeepSeek reasoning models require that any reasoning_content emitted in a
// prior assistant turn be echoed back verbatim on the next request, but the
// Responses<->Chat translation here rebuilds assistant turns from Codex's
// history and has nowhere to carry that field. Stash it out-of-band, keyed
// by the item/call id we handed back to Codex, and reattach on replay.
const reasoningStore = new Map<string, string>();

function toChat(body: Json) {
  const messages: Json[] = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  const input =
    typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input || [];

  // Codex can fire several tool calls in one turn (parallel shell commands).
  // OpenAI-compatible endpoints (incl. DeepSeek) require all concurrent calls
  // to live in ONE assistant message, with every tool_call_id answered by the
  // immediately following tool messages. So buffer consecutive call items and
  // flush them as a single assistant message before any non-call item.
  let pendingCalls: Array<{
    id: string;
    name: string;
    arguments: string;
    reasoning_content?: string;
  }> = [];
  const flushCalls = () => {
    if (!pendingCalls.length) return;
    const reasoning_content = pendingCalls.find((c) => c.reasoning_content)?.reasoning_content;
    messages.push({
      role: "assistant",
      content: null,
      ...(reasoning_content ? { reasoning_content } : {}),
      tool_calls: pendingCalls.map(({ id, name, arguments: args }) => ({
        id,
        type: "function",
        function: { name, arguments: args },
      })),
    });
    pendingCalls = [];
  };

  for (const item of input) {
    if (item.type === "message" || item.role) {
      flushCalls();
      const content = textContent(item.content);
      const role = item.role === "developer" ? "system" : item.role || "user";
      if (content) {
        const msg: Json = { role, content };
        const reasoning_content = item.id && reasoningStore.get(item.id);
        if (reasoning_content) msg.reasoning_content = reasoning_content;
        messages.push(msg);
      }
    } else if (item.type === "function_call") {
      const reasoning_content = reasoningStore.get(item.call_id || item.id);
      pendingCalls.push({
        id: item.call_id || item.id,
        name: item.name,
        arguments: item.arguments || "{}",
        ...(reasoning_content ? { reasoning_content } : {}),
      });
    } else if (item.type === "function_call_output") {
      flushCalls();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: textContent(item.output) || String(item.output || ""),
      });
    } else if (item.type === "custom_tool_call") {
      const reasoning_content = reasoningStore.get(item.call_id || item.id);
      pendingCalls.push({
        id: item.call_id || item.id,
        name: item.name,
        arguments: JSON.stringify({ input: item.input || "" }),
        ...(reasoning_content ? { reasoning_content } : {}),
      });
    } else if (item.type === "custom_tool_call_output") {
      flushCalls();
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: textContent(item.output) || String(item.output || ""),
      });
    }
  }
  flushCalls();

  const custom = new Set<string>();
  const tools = (body.tools || []).flatMap((tool: Json) => {
    if (tool.type === "function") {
      const fn = tool.function || tool;
      return [
        {
          type: "function",
          function: {
            name: fn.name,
            description: fn.description || "",
            parameters: fn.parameters || { type: "object", properties: {} },
          },
        },
      ];
    }
    if (tool.type === "custom" && tool.name) {
      custom.add(tool.name);
      return [
        {
          type: "function",
          function: {
            name: tool.name,
            description: `${tool.description || ""}\nReturn the custom tool input in the input field.`,
            parameters: {
              type: "object",
              properties: { input: { type: "string" } },
              required: ["input"],
            },
          },
        },
      ];
    }
    return [];
  });

  return {
    request: {
      model,
      messages,
      ...(tools.length ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: body.max_output_tokens,
    },
    custom,
  };
}

function sse(data: Json | "[DONE]"): string {
  return `data: ${data === "[DONE]" ? data : JSON.stringify(data)}\n\n`;
}

async function responses(request: Request): Promise<Response> {
  let body: Json;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { message: "invalid JSON" } }, { status: 400 });
  }
  const { request: chat, custom } = toChat(body);
  const requestBody = JSON.stringify(chat);
  const upstreamResponse = await fetch(`${upstream}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: requestBody,
  });
  if (process.env.DEEPSEEK_DEBUG) {
    console.error(
      `[deepseek-adapter] upstream ${upstreamResponse.status} ${upstreamResponse.statusText}`,
    );
  }
  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const upstreamBody = await upstreamResponse.text();
    if (process.env.DEEPSEEK_DEBUG) {
      console.error(`[deepseek-adapter] request: ${requestBody.slice(0, 3000)}`);
      console.error(`[deepseek-adapter] upstream error body: ${upstreamBody.slice(0, 3000)}`);
    }
    return new Response(upstreamBody, {
      status: upstreamResponse.status,
      headers: {
        "Content-Type": upstreamResponse.headers.get("content-type") || "application/json",
      },
    });
  }

  const responseId = `resp_deepseek_${crypto.randomUUID().replaceAll("-", "")}`;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: Json | "[DONE]") => controller.enqueue(encoder.encode(sse(event)));
      const responseBase = {
        id: responseId,
        object: "response",
        model,
        status: "in_progress",
        output: [],
      };
      emit({ type: "response.created", response: responseBase });
      emit({ type: "response.in_progress", response: responseBase });
      let buffer = "";
      let textStarted = false;
      let text = "";
      let reasoning = "";
      let usage: Json = {};
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      const reader = upstreamResponse.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            const chunk = JSON.parse(payload);
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk.choices?.[0]?.delta || {};
            if (delta.reasoning_content) reasoning += delta.reasoning_content;
            if (delta.content) {
              if (!textStarted) {
                textStarted = true;
                emit({
                  type: "response.output_item.added",
                  output_index: 0,
                  item: {
                    id: `${responseId}_msg`,
                    type: "message",
                    role: "assistant",
                    status: "in_progress",
                    content: [],
                  },
                });
                emit({
                  type: "response.content_part.added",
                  item_id: `${responseId}_msg`,
                  output_index: 0,
                  content_index: 0,
                  part: { type: "output_text", text: "", annotations: [] },
                });
              }
              text += delta.content;
              emit({
                type: "response.output_text.delta",
                item_id: `${responseId}_msg`,
                output_index: 0,
                content_index: 0,
                delta: delta.content,
              });
            }
            for (const call of delta.tool_calls || []) {
              const index = call.index || 0;
              const current = toolCalls.get(index) || {
                id: call.id || `call_${crypto.randomUUID()}`,
                name: "",
                arguments: "",
              };
              if (call.id) current.id = call.id;
              if (call.function?.name) current.name += call.function.name;
              if (call.function?.arguments) current.arguments += call.function.arguments;
              toolCalls.set(index, current);
            }
          }
        }
        const output: Json[] = [];
        if (textStarted) {
          const item = {
            id: `${responseId}_msg`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          emit({
            type: "response.output_text.done",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            text,
          });
          emit({
            type: "response.content_part.done",
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: item.content[0],
          });
          emit({ type: "response.output_item.done", output_index: 0, item });
          output.push(item);
          if (reasoning) reasoningStore.set(item.id, reasoning);
        }
        for (const [, call] of [...toolCalls].sort(([a], [b]) => a - b)) {
          if (reasoning) reasoningStore.set(call.id, reasoning);
          const outputIndex = output.length;
          if (custom.has(call.name)) {
            let input = call.arguments;
            try {
              input = JSON.parse(call.arguments).input ?? call.arguments;
            } catch {}
            const item = {
              id: `${responseId}_tool_${outputIndex}`,
              type: "custom_tool_call",
              status: "completed",
              call_id: call.id,
              name: call.name,
              input,
            };
            emit({
              type: "response.output_item.added",
              output_index: outputIndex,
              item: { ...item, status: "in_progress", input: "" },
            });
            emit({
              type: "response.custom_tool_call_input.delta",
              item_id: item.id,
              output_index: outputIndex,
              delta: input,
            });
            emit({
              type: "response.custom_tool_call_input.done",
              item_id: item.id,
              output_index: outputIndex,
              input,
            });
            emit({ type: "response.output_item.done", output_index: outputIndex, item });
            output.push(item);
          } else {
            const item = {
              id: `${responseId}_tool_${outputIndex}`,
              type: "function_call",
              status: "completed",
              call_id: call.id,
              name: call.name,
              arguments: call.arguments,
            };
            emit({
              type: "response.output_item.added",
              output_index: outputIndex,
              item: { ...item, status: "in_progress", arguments: "" },
            });
            emit({
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: outputIndex,
              delta: call.arguments,
            });
            emit({
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: outputIndex,
              arguments: call.arguments,
            });
            emit({ type: "response.output_item.done", output_index: outputIndex, item });
            output.push(item);
          }
        }
        emit({
          type: "response.completed",
          response: {
            ...responseBase,
            status: "completed",
            output,
            usage: {
              input_tokens: usage.prompt_tokens || 0,
              output_tokens: usage.completion_tokens || 0,
              total_tokens: usage.total_tokens || 0,
            },
          },
        });
        emit("[DONE]");
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      (url.pathname === "/v1/responses" || url.pathname === "/responses")
    )
      return responses(request);
    if (url.pathname === "/health") return Response.json({ ok: true, model });
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  },
});

const codexHome = join(root, ".codex-deepseek");
mkdirSync(codexHome, { recursive: true });

// The DeepSeek provider config that used to be injected as codex `-c` flags.
// Now written to CODEX_HOME/config.toml instead, because codex is spawned
// through the agent-yes wrapper (`ay codex`) whose yargs parser would swallow
// `-c` (alias of --continue) before it ever reached codex.
const configToml = [
  `model_provider = "deepseek"`,
  `model = "${model}"`,
  `model_supports_reasoning_summaries = false`,
  `model_context_window = 1000000`,
  ``,
  `[model_providers.deepseek]`,
  `name = "DeepSeek local adapter"`,
  `base_url = "http://127.0.0.1:${server.port}/v1"`,
  `env_key = "DEEPSEEK_PROXY_KEY"`,
  `wire_api = "responses"`,
  // Let codex absorb transient upstream 5xx (e.g. DeepSeek gateway 502s) with
  // its built-in exponential backoff instead of surfacing them to the user.
  `request_max_retries = 3`,
  `stream_max_retries = 3`,
].join("\n");
writeFileSync(join(codexHome, "config.toml"), configToml);

if (process.env.DEEPSEEK_SERVER_ONLY) {
  // Debug mode: run the adapter without spawning codex so the upstream request
  // can be driven by an external codex/curl invocation. Serve until signalled.
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, resolve);
  });
  server.stop(true);
  process.exit(0);
}

// Spawn codex THROUGH the agent-yes wrapper so the session is a first-class
// agent: registered in `ay ls`, tail-able, resumable, auto-yes, etc. AGENT_YES_BIN
// is injected by `ay ds`; fall back to `ay` on PATH for a bare `bun run deepseek`.
// Exception: `exec` subcommand, whose non-interactive one-shot runs don't need
// agent registration, and which the wrapper's codex `defaultArgs` (`--search`)
// would break (`codex --search exec` is an unknown-argument error).
const args = process.argv.slice(2);
const ayBin = process.env.AGENT_YES_BIN || "ay";
const isExec = args[0] === "exec";
const spawnedAt = Date.now();
const child = Bun.spawn(isExec ? ["codex", ...args] : [ayBin, "codex", ...args], {
  cwd: process.cwd(),
  env: { ...process.env, CODEX_HOME: codexHome, DEEPSEEK_PROXY_KEY: "local-adapter" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
const exitCode = await child.exited;

// When `ay codex` is launched from a nested non-TTY context (AGENT_YES_PID set
// + stdout piped) the wrapper detaches the codex agent and returns immediately
// (see cli.ts shouldForkNested). That orphaned agent still talks to THIS
// adapter, so tearing the server down here would break it mid-stream. Keep
// serving until every codex agent this invocation spawned has exited.
await waitForOrphanedCodex(spawnedAt);

server.stop(true);
process.exit(exitCode);

// ---------------------------------------------------------------------------
// orphan-aware server teardown
// ---------------------------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Last-wins-per-pid view of the agent registry (~/.agent-yes/pids.jsonl). */
function readAgentRegistry(): Array<{
  pid: number;
  cli?: string;
  cwd?: string;
  status?: string;
  started_at?: number;
}> {
  const pidsPath = join(homedir(), ".agent-yes", "pids.jsonl");
  let raw: string;
  try {
    raw = readFileSync(pidsPath, "utf-8");
  } catch {
    return [];
  }
  const merged = new Map<number, any>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const doc = JSON.parse(trimmed);
      if (typeof doc.pid === "number") {
        const prev = merged.get(doc.pid);
        merged.set(doc.pid, prev ? { ...prev, ...doc } : doc);
      }
    } catch {
      /* skip corrupt */
    }
  }
  return [...merged.values()];
}

async function waitForOrphanedCodex(spawnedAt: number): Promise<void> {
  const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const orphan = readAgentRegistry().find(
      (r) =>
        r.cli === "codex" &&
        r.cwd === process.cwd() &&
        typeof r.started_at === "number" &&
        r.started_at >= spawnedAt - 5000 &&
        r.status !== "exited" &&
        isPidAlive(r.pid),
    );
    if (!orphan) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
