# Agent Environment Documentation

This document describes the environment available in the agent-yes Docker container.

## Image Variants

### Full Image (`snomiao/agent-yes:latest`)

- **Size**: ~2.2 GB
- **Base**: `node:latest` (Debian Bookworm)
- **Includes**:
  - Node.js, Bun
  - Rust toolchain (for building native modules)
  - Python3 and build-essential
  - All AI agent CLIs pre-installed:
    - `@anthropic-ai/claude-code`
    - `@qwen-code/qwen-code`
    - `@vibe-kit/grok-cli`
    - `@google/gemini-cli`
    - `@openai/codex`
    - `@github/copilot`
    - `@augmentcode/auggie`
    - `opencode-ai`

### Mini Image (`snomiao/agent-yes:mini`) ⚡

- **Size**: ~200-300 MB
- **Base**: `node:alpine`
- **Includes**:
  - Node.js, Bun
  - Git, Bash, Curl
  - agent-yes CLI only

**What's NOT included in mini:**

- Rust toolchain
- Python3 and build tools
- AI agent CLIs (need manual installation)

## When to Use Which Image?

### Use Mini Image When:

- You only need agent-yes CLI
- You want fast pod creation (~10-30s vs 2-5min)
- You're on bandwidth/storage constrained environments
- You'll install additional tools on-demand

### Use Full Image When:

- You need all AI agent CLIs immediately available
- You're building projects that require compilation (Rust/C++)
- You want a complete development environment
- Network bandwidth/download time isn't a concern

## Installing Additional Tools

If you're using the mini image and need additional tools, see [SETUP.md](./SETUP.md) for installation commands.

## Environment Variables

The following environment variables are typically required:

```bash
# For Claude Code
ANTHROPIC_API_KEY=your-key-here

# For other agents (if installed)
QWEN_API_KEY=your-key-here
GROQ_API_KEY=your-key-here
GEMINI_API_KEY=your-key-here
OPENAI_API_KEY=your-key-here
```

## Current Environment

To check which image you're running:

```bash
# Check image size
docker images snomiao/agent-yes

# Check available agents
which claude-code qwen-code grok gemini codex copilot auggie opencode 2>/dev/null || echo "Mini image - no agents pre-installed"

# Check if Rust is installed
rustc --version 2>/dev/null || echo "Rust not installed (mini image)"
```

## More Information

- See [SETUP.md](./SETUP.md) for manual installation commands
- See [../README.md](../README.md) for general agent-yes documentation
- Report issues: https://github.com/snomiao/agent-yes/issues
