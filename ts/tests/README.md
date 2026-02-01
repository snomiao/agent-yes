# Test Suite

## Mock CLI

### `mock-claude-cli.ts`

A mock Claude CLI for testing agent-yes FIFO functionality.

**Features:**

- Simulates Claude's ready pattern (`? for shortcuts`)
- Accepts input via stdin (including merged FIFO input)
- Logs all received prompts to `.agent-yes/mock-received.log`
- Handles `/exit` command to terminate cleanly
- Supports positional prompt arg (mimics `promptArg: "last-arg"`)

**Usage:**

```bash
bun ts/tests/mock-claude-cli.ts [prompt]
```

### `mock-claude-cli.spec.ts`

Integration test for FIFO `--append-prompt` functionality.

**Test Coverage:**

1. ✅ Start agent-yes with mock CLI and `--fifo` enabled
2. ✅ Wait for agent to be ready (detects FIFO hint in stderr)
3. ✅ Use `--append-prompt` to send prompt via FIFO
4. ✅ Verify mock CLI received the prompt
5. ✅ Test failure when no active FIFO agent exists

**Run Tests:**

```bash
bun test ts/tests/mock-claude-cli.spec.ts
```

## Architecture

The test uses a custom `.agent-yes/config.ts` in the test directory to override the claude binary path, pointing it to the mock CLI. This allows testing the full integration without requiring the actual Claude CLI to be installed.
