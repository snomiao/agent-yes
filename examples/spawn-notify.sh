#!/usr/bin/env bash
# spawn-notify — fan-out completion detection for an orchestrator parent.
#
# Spawns an agent-yes agent FIRE-AND-FORGET (it outlives this script), then
# BLOCKS until the agent needs attention. Launch THIS via the parent's
# background runner (e.g. Claude Code's run_in_background): a background command
# only notifies its parent when the PROCESS EXITS, but an agent never exits — it
# idles at its prompt waiting for re-instruction. So we let a tiny sibling — this
# script, blocked on `ay status --wait` — be the thing that exits. The agent
# itself keeps living, so you can still re-instruct it with `ay send <pid> "…"`.
#
# Verified: a nohup+disown child survives the spawning shell's exit, so the agent
# outlives this waiter.
#
# Usage:   spawn-notify <cwd> -- <task...>
# Env:     CLI=claude          wrapped CLI (claude|codex|gemini|…)
#          AY_FLAGS="-y"       extra flags for `ay <cli>` (e.g. -y for yolo)
#          WAIT_MODE=--wait    --wait      → wake on idle|needs_input|stuck|stopped (recommended:
#                                            also catches a blocked AskUserQuestion menu)
#                              --wait-idle → wake on idle only (misses blocked menus)
#          WAIT_TIMEOUT=6h     waiter timeout (ms() syntax: 30s, 5m, 6h)
# Exit:    0  agent needs attention (idle / blocked-on-input / done)
#          2  waiter timed out (agent still actively working)
#          3  agent never registered in ~/.agent-yes/pids.jsonl
set -uo pipefail

cli="${CLI:-claude}"
cwd="${1:?usage: spawn-notify <cwd> -- <task...>}"; shift
[ "${1:-}" = "--" ] && shift
task="$*"

# 1) Fire-and-forget. nohup+disown so the agent outlives this waiter; agent-yes
#    keeps its own PTY log under ~/.agent-yes, so /dev/null here loses nothing.
mkdir -p "$cwd"
# shellcheck disable=SC2086
nohup ay "$cli" ${AY_FLAGS:-} --cwd "$cwd" -- "$task" >/dev/null 2>&1 &
disown || true

# 2) Resolve the agent we just spawned to an EXACT pid (newest match in this cwd),
#    retrying until its record lands in pids.jsonl. From here on we key off the
#    pid — exact identity, no --latest ambiguity, no sibling-collision risk.
pid=""
for _ in $(seq 1 30); do
  pid=$(ay status "$cwd" --latest 2>/dev/null | sed -n 's/.*"pid":\([0-9]\{1,\}\).*/\1/p' | head -1)
  [ -n "$pid" ] && break
  sleep 1
done
[ -z "$pid" ] && { echo "spawn-notify: agent never registered under $cwd" >&2; exit 3; }
echo "spawn-notify: agent pid=$pid cwd=$cwd — waiting (${WAIT_MODE:---wait})…" >&2

# 3) Block until the ball is in the parent's court. Pid keyword = exact identity.
ay status "$pid" "${WAIT_MODE:---wait}" --timeout "${WAIT_TIMEOUT:-6h}"
rc=$?

# 4) Surface the structured envelope (if the agent ran `ay result set '{...}'`) so
#    it rides along in the parent's notification payload. Non-fatal if absent.
ay result "$pid" 2>/dev/null || true
exit $rc
