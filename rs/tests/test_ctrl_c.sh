#!/usr/bin/env bash
# Test Ctrl+C handling for agent-yes Rust implementation
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BINARY="$PROJECT_DIR/target/release/agent-yes"

# Build the release binary if not present
if [ ! -f "$BINARY" ]; then
    echo "Building release binary..."
    cd "$PROJECT_DIR" && cargo build --release
fi

# Create a mock claude script that never shows the ready pattern
MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'EOF'
#!/usr/bin/env bash
echo "Starting Claude..."
echo "Loading..."
# Sleep forever - never shows ready pattern
sleep 10000
EOF
chmod +x "$MOCK_CLAUDE"

# Create a test directory
TEST_DIR=$(mktemp -d)
cp "$MOCK_CLAUDE" "$TEST_DIR/claude"
chmod +x "$TEST_DIR/claude"

cleanup() {
    rm -f "$MOCK_CLAUDE"
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "Testing Ctrl+C handling..."
echo "Using mock claude at: $TEST_DIR/claude"

# Use script command to create a PTY and test Ctrl+C
# This is a simplified version - the actual test would need proper PTY handling
cd "$TEST_DIR"

# Run with timeout and expect it to handle Ctrl+C
timeout 5s bash -c "
    export PATH='$TEST_DIR:\$PATH'
    echo 'Spawning agent-yes...'
    $BINARY --verbose --no-robust claude -- hello &
    PID=\$!
    sleep 1
    echo 'Sending SIGINT...'
    kill -INT \$PID 2>/dev/null || true
    wait \$PID 2>/dev/null
    echo 'Done'
" 2>&1 || true

echo "Test completed. Check output above for 'User aborted: SIGINT' message."
