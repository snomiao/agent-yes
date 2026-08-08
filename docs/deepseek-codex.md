# Codex with DeepSeek

A local-only adapter that lets Codex CLI use DeepSeek's Chat Completions API.
It does not modify `~/.codex/config.toml`, global Codex authentication, or the
globally linked `agent-yes` package. Codex is launched through the agent-yes
wrapper, so the session is a first-class agent (`ay ls`, `ay tail`, resume, …).

## Setup

Create `.env.local` in the repository root:

```dotenv
DEEPSEEK_API_KEY=your-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

For a machine-global token (works from any working directory), put the same
keys in `~/.agent-yes/.env.local` instead. Precedence is: ambient env → repo
`.env.local` → `~/.agent-yes/.env.local`.

`.env.local` and `.codex-deepseek/` are ignored by Git. The latter is an
isolated `CODEX_HOME`, so DeepSeek sessions and Codex state stay inside this
clone.

## Run

Interactive Codex:

```bash
ay ds
```

With a prompt:

```bash
ay ds "explain this codebase"
```

Non-interactive Codex:

```bash
ay ds exec --skip-git-repo-check "Inspect this repository"
```

All arguments after `ds`/`deepseek` are forwarded to Codex. The launcher starts
a loopback-only Responses-to-Chat-Completions adapter, runs Codex against it via
the agent-yes wrapper, and stops the adapter when Codex exits. When launched
from a nested non-TTY context (e.g. another agent), the inner `ay codex` detaches
the session; the adapter keeps serving until that orphaned session exits.

`exec` invocations spawn Codex directly instead of via the agent-yes wrapper
(the wrapper's `defaultArgs` would inject `--search`, which `exec` rejects).

## Debugging

Set `DEEPSEEK_DEBUG=1` to log each upstream request's status (and the request
body on failure) to stderr:

```bash
DEEPSEEK_DEBUG=1 ay ds "explain this codebase"
```

Transient upstream 5xx (e.g. DeepSeek gateway 502s) are absorbed by Codex's
built-in retries (`request_max_retries`/`stream_max_retries` are set to 3).
`DEEPSEEK_SERVER_ONLY=1` runs just the adapter (no Codex) for driving it with
an external client.

## Compatibility

The adapter translates text, function calls, custom tool calls, tool results,
and streaming SSE events. It has been smoke-tested with Codex CLI 0.146.0 and
`deepseek-v4-pro`, including a real shell-tool round trip.
