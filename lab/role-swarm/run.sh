#!/usr/bin/env bash
# Validation run: prompts carry NO peer-discovery instructions.
# Swarm awareness comes entirely from ay's --append-system-prompt injection.
set -e
cd "$(dirname "$0")"

echo "Spawning designer..."
ay claude -- "You are a UX designer for a todo-app. Answer design questions." &

sleep 2

echo "Spawning builder..."
ay claude -- "You are a builder on a todo-app. You need a design decision: should the primary action button say 'Add' or 'Add task', and top or bottom of list? Get input, then write result.md here with: who you asked, question, answer, your decision." &

echo ""
echo "Watch with:  ay ls   |   ay tail -f designer   |   ay tail -f builder"
echo "Waiting for result.md..."
while [ ! -f result.md ]; do sleep 3; done
echo ""; cat result.md
