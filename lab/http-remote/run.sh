#!/usr/bin/env bash
# HTTP remote demo: ay serve + remote routing.
# Simulates a "remote" machine by running ay serve locally,
# then accessing agents via token@host:port syntax.
set -e
cd "$(dirname "$0")"

PORT=7432

echo "Starting ay serve on port $PORT..."
ay serve --port $PORT &
SERVER_PID=$!
sleep 2

# Read the auto-generated token
TOKEN=$(cat ~/.agent-yes/.serve-token)
echo "Token: $TOKEN"
echo ""

echo "Spawning a worker agent..."
ay claude -- "$(cat worker.md)" &

sleep 2

echo ""
echo "--- Remote access examples ---"
echo ""
echo "List agents via HTTP:"
ay ls "$TOKEN@localhost:$PORT"

echo ""
echo "Now the 'remote' client can send commands:"
echo "  ay send $TOKEN@localhost:$PORT:<keyword> \"message\""
echo "  ay tail $TOKEN@localhost:$PORT:<keyword>"
echo ""
echo "Or save as alias:"
echo "  ay remote add local-demo http://$TOKEN@localhost:$PORT"
echo "  ay ls local-demo"
echo ""
echo "Press Ctrl-C to stop."
wait $SERVER_PID
