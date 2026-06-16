#!/usr/bin/env bash
# Mock Claude CLI — a token-free stand-in for the real `claude` binary, used to
# exercise agent-yes's wrapper behavior (ready detection, auto-Enter, idle exit,
# prompt echo) WITHOUT spawning a real Claude Code session or spending tokens.
#
# Usage (override the real `claude` on PATH for one run):
#   mkdir -p tests/mock-bin
#   ln -sf "$PWD/tests/mock-claude.sh" "$PWD/tests/mock-bin/claude"
#   PATH="$PWD/tests/mock-bin:$PATH" ay claude -- "quote test"
#
# It emits the markers agent-yes keys off of (see rs/default.config.yaml):
#   - the ready cue `? for shortcuts`     -> agent-yes starts the idle timer
#   - a `Press Enter to continue` prompt  -> agent-yes auto-sends Enter
# then echoes whatever prompt/stdin it receives and goes idle so `--idle` exits.

# The prompt is passed as the last CLI arg (claude promptArg = last-arg).
PROMPT="${*: -1}"

echo "Welcome to Claude! (mock — no tokens spent)"
echo "? for shortcuts"

# Prove the auto-yes path: agent-yes should answer this for us.
echo "Press Enter to continue"
read -r _ack
echo "CONTINUED"

# Echo the prompt we were launched with, if any.
if [ -n "$PROMPT" ]; then
  echo "mock response to: $PROMPT"
fi

# Echo any further stdin (interactive appends), then idle.
while read -r line; do
  echo "mock response to: $line"
done
