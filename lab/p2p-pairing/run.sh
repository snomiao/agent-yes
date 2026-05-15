#!/usr/bin/env bash
# P2P pairing: two agents connected via libp2p swarm.
# Requires a Rust binary built with swarm support:
#   cargo install --path rs --features swarm
#
# Same-machine: mDNS auto-discovery. Cross-machine: share the same TOPIC.
set -e
cd "$(dirname "$0")"

TOPIC="${1:-p2p-lab-$$}"
echo "Swarm topic: $TOPIC"
echo "  (share this topic with a peer on another machine to connect cross-machine)"
echo ""

echo "Spawning pong agent..."
ay claude --swarm "$TOPIC" -- "$(cat pong.md)" &

sleep 3

echo "Spawning ping agent..."
ay claude --swarm "$TOPIC" -- "$(cat ping.md)" &

echo ""
echo "Watch with:  ay ls   |   ay tail -f pong   |   ay tail -f ping"
echo "Waiting for result.md..."
while [ ! -f result.md ]; do sleep 3; done
echo ""; cat result.md
