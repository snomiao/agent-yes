# Codex with DeepSeek

Two ways to run the Codex CLI against DeepSeek's V4 Pro model. Both are pure
configuration — `binary: codex` plus a few `-c` overrides in
`default.config.yaml`. Neither needs a translating proxy, an isolated
`CODEX_HOME`, a helper script, or a config file of your own: a stock `codex`
install is enough.

| | `ay codex-ds` | `ay codex-ds-direct` |
|---|---|---|
| Route | OpenRouter | DeepSeek's own endpoint |
| Model | `deepseek/deepseek-v4-pro-0813` | `deepseek-v4-pro` |
| Requires | `OPENROUTER_API_KEY` | `DEEPSEEK_API_KEY` |
| Billing | OpenRouter credits | DeepSeek account |

Pick `codex-ds` to keep one key across many providers, or `codex-ds-direct` to
bill DeepSeek straight and drop a network hop plus the reseller margin.

## Setup

Export the key for whichever route you use:

```bash
export OPENROUTER_API_KEY=...   # for codex-ds
export DEEPSEEK_API_KEY=...     # for codex-ds-direct
```

To set it per machine instead of per shell, add it to `~/.agent-yes.config.yaml`
under the CLI's `env` block — that file is cascaded over the packaged defaults
by both runtimes:

```yaml
clis:
  codex-ds-direct:
    env:
      DEEPSEEK_API_KEY: your-key
```

## Run

```bash
ay codex-ds                              # interactive
ay codex-ds "explain this codebase"      # with a prompt
ay -y codex-ds "refactor the parser"     # auto-approve tool use
```

`ay -y` maps to codex's `--dangerously-bypass-approvals-and-sandbox`, and the
`enter:` markers auto-accept codex's `› 1. Yes / Approve / Allow` menus. Both
work the same on `codex-ds-direct`.

## Why no adapter is needed

Codex 0.147 dropped the Chat Completions wire protocol — `wire_api` must be
`"responses"`. Both providers serve that natively:

- OpenRouter exposes `POST /api/v1/responses`.
- DeepSeek gained Responses API support in the 2026-08-13 V4 Pro update
  ([docs](https://api-docs.deepseek.com/guides/responses_api/)).

Because reasoning arrives as a first-class `{"type": "reasoning"}` output item
on this protocol, there is also nothing to shuttle out of band between turns —
that was a Chat Completions constraint.

## Model ids differ per route

DeepSeek's own `/models` lists exactly `deepseek-v4-flash` and `deepseek-v4-pro`
— there are no dated snapshot ids there. OpenRouter does publish dated
snapshots, which is why the two entries name different models.

## Provider config is passed inline

Codex 0.147 rejects a `[profiles.X]` table inside `config.toml` and wants it in
a separate `<X>.config.toml`. Passing the provider table as `-c` overrides
sidesteps that entirely, which is what keeps these entries free of any
user-side config file.
