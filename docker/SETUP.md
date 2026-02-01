# Setup Guide - Installing Additional Toolchains

This guide provides installation commands for all toolchains and AI agent CLIs that are included in the full image but not in the mini image.

## Quick Start - Install Everything

If you want to replicate the full environment, run all commands in order:

```bash
# Update package manager (Alpine)
apk update

# Install build tools
apk add --no-cache \
    build-base \
    python3 \
    python3-dev \
    make \
    g++ \
    gcc

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source $HOME/.cargo/env

# Install all AI agent CLIs
npm i -g \
    @anthropic-ai/claude-code \
    @qwen-code/qwen-code \
    @vibe-kit/grok-cli \
    @google/gemini-cli \
    @openai/codex \
    @github/copilot \
    @augmentcode/auggie \
    opencode-ai
```

## Individual Installation Guides

### Build Tools (Required for native modules)

**Alpine Linux:**

```bash
apk add --no-cache \
    build-base \
    python3 \
    python3-dev \
    make \
    g++ \
    gcc
```

**Debian/Ubuntu:**

```bash
apt-get update && apt-get install -y \
    build-essential \
    python3 \
    python3-dev
```

### Rust Toolchain

Install Rust (required for building some native modules like bun-pty):

```bash
# Install rustup and Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Load Rust environment
source $HOME/.cargo/env

# Verify installation
rustc --version
cargo --version
```

### AI Agent CLIs

Install AI agent command-line interfaces individually or all at once:

#### Claude Code (Anthropic)

```bash
npm i -g @anthropic-ai/claude-code
# Requires: ANTHROPIC_API_KEY
```

#### Qwen Code

```bash
npm i -g @qwen-code/qwen-code
# Requires: QWEN_API_KEY
```

#### Grok CLI

```bash
npm i -g @vibe-kit/grok-cli
# Requires: GROQ_API_KEY
```

#### Gemini CLI (Google)

```bash
npm i -g @google/gemini-cli
# Requires: GEMINI_API_KEY
```

#### Codex (OpenAI)

```bash
npm i -g @openai/codex
# Requires: OPENAI_API_KEY
```

#### GitHub Copilot

```bash
npm i -g @github/copilot
# Requires: GitHub authentication
```

#### Auggie (AugmentCode)

```bash
npm i -g @augmentcode/auggie
# Requires: AUGMENT_API_KEY
```

#### OpenCode AI

```bash
npm i -g opencode-ai
# Requires: OPENAI_API_KEY
```

#### Install All Agents at Once

```bash
npm i -g \
    @anthropic-ai/claude-code \
    @qwen-code/qwen-code \
    @vibe-kit/grok-cli \
    @google/gemini-cli \
    @openai/codex \
    @github/copilot \
    @augmentcode/auggie \
    opencode-ai
```

### Optional: Database CLIs

#### PostgreSQL Client

**Alpine:**

```bash
apk add --no-cache postgresql-client
```

**Debian/Ubuntu:**

```bash
apt-get update && apt-get install -y postgresql-client
```

### Optional: Go Language

**Alpine:**

```bash
apk add --no-cache go
```

**Debian/Ubuntu:**

```bash
apt-get update && apt-get install -y golang-go
```

## Environment Variables Setup

After installing the agents, configure your API keys:

```bash
# Claude Code
export ANTHROPIC_API_KEY="your-anthropic-key-here"

# Qwen Code
export QWEN_API_KEY="your-qwen-key-here"

# Grok CLI
export GROQ_API_KEY="your-groq-key-here"

# Gemini
export GEMINI_API_KEY="your-gemini-key-here"

# OpenAI (for Codex and OpenCode AI)
export OPENAI_API_KEY="your-openai-key-here"

# Auggie
export AUGMENT_API_KEY="your-augment-key-here"
```

To persist these, add them to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.) or container environment configuration.

## Verification

Check what's installed:

```bash
# Check build tools
gcc --version
python3 --version

# Check Rust
rustc --version

# Check agents
claude-code --version
qwen-code --version
grok --version
gemini --version
codex --version
copilot --version
auggie --version
opencode --version
```

## Troubleshooting

### "Command not found" after npm install

Make sure npm's global bin directory is in your PATH:

```bash
export PATH="$(npm config get prefix)/bin:$PATH"
```

### Rust not found after installation

Load the Rust environment:

```bash
source $HOME/.cargo/env
```

Or add to your shell profile:

```bash
echo 'source $HOME/.cargo/env' >> ~/.bashrc
```

### Build failures with native modules

Make sure you have build tools installed:

```bash
# Alpine
apk add build-base python3-dev

# Debian/Ubuntu
apt-get install build-essential python3-dev
```

## More Information

- See [AGENTS.md](./AGENTS.md) for image variant comparison
- Report issues: https://github.com/snomiao/agent-yes/issues
