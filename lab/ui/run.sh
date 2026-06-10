#!/usr/bin/env bash
# Lab: an interactive web console for agent-yes.
#
# codehost (the read-only access list on :7700) renders `ay ls` and stops there.
# This lab adds the read-write half codehost structurally can't: click an agent,
# watch its log stream live, and type a message straight into its stdin.
#
# How it works: `ay serve` already exposes the whole API (ls / tail-SSE / send).
# We just start it and put a tiny same-origin proxy (server.ts) in front that
# serves index.html and injects the auth token — no new backend, no CORS.
set -e
cd "$(dirname "$0")"

AY_PORT="${AY_PORT:-7432}"
UI_PORT="${UI_PORT:-7777}"

echo "Starting ay serve on :$AY_PORT …"
ay serve --port "$AY_PORT" &
SERVE_PID=$!
trap 'kill $SERVE_PID 2>/dev/null' EXIT
sleep 1.5

echo "Starting lab UI on :$UI_PORT …"
echo ""
echo "  open →  http://localhost:$UI_PORT"
echo ""
AY_API="http://127.0.0.1:$AY_PORT" UI_PORT="$UI_PORT" bun server.ts
