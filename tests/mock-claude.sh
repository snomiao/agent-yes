#!/usr/bin/env bash
# Mock Claude CLI for testing
# This script simulates a Claude CLI that takes some time to start

echo "Welcome to Claude! I can help you with a variety of tasks."
echo "What would you like help with today?"

# Wait for stdin and just echo back
while read -r line; do
  echo "Claude response: $line"
  sleep 0.1
done
