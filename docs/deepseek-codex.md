# Codex with DeepSeek

Codex を DeepSeek で動かす経路は 2 つある。**まず `ay codex-ds` を試すこと。**
そちらで足りない場合にだけ、このアダプタを使う。

| | `ay codex-ds` | このアダプタ (`ay ds`) |
|---|---|---|
| 経路 | OpenRouter (`deepseek/deepseek-v4-pro-0813`) | DeepSeek API に直結 |
| 仕組み | codex に `-c` オーバーライドを渡すだけ。追加プロセスなし | ローカル HTTP プロキシを立てて Responses ⇄ Chat Completions を変換 |
| 必要なもの | `OPENROUTER_API_KEY` のみ | `DEEPSEEK_API_KEY` |
| 設定ファイル | 不要 (素の codex install で動く) | 隔離した `CODEX_HOME` を自動生成 |

**`ay codex-ds` を既定にする理由**: 変換レイヤを挟まないぶん壊れる箇所が少ない。
codex が `wire_api = "responses"` しか話さなくなった (0.147) 一方で OpenRouter は
`POST /api/v1/responses` を提供しているため、間に何も要らない。

**このアダプタが必要になる場合**: DeepSeek に直接課金したい、OpenRouter を経由
させたくない、あるいは OpenRouter に無いモデル (`DEEPSEEK_MODEL`) を指名したいとき。
DeepSeek の API は Chat Completions しか提供していないので、codex の Responses
リクエストを変換するプロキシがどうしても要る。推論モデルが直前のターンで出した
`reasoning_content` を次のリクエストに逐語で返す必要がある点も、ここで吸収している。

どちらも codex セッションは agent-yes ラッパー経由で起動するので、一級の agent
(`ay ls` / `ay tail` / resume) として扱える。

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
