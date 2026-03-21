# Agent-Yes! for Claude/Codex/Gemini/Cursor/Copilot/Qwen/Auggie

A wrapper tool that automates interactions with various AI CLI tools by automatically handling common prompts and responses. Originally designed for Claude CLI, now supports multiple AI coding assistants. Rewritten in Rust for improved performance and reliability.

⚠️ **Important Security Warning**: Only run this on trusted repositories. This tool automatically responds to prompts and can execute commands without user confirmation. Be aware of potential prompt injection attacks where malicious code or instructions could be embedded in files or user inputs to manipulate the automated responses.

## Features

- **Multi-CLI Support**: Works with Claude, Gemini, Codex, Copilot, and Cursor CLI tools
- **Auto-Response**: Automatically responds to common prompts like "Yes, proceed" and "Yes"
- **Continuous Operation**: Keeps the AI assistant running until your task is done, waiting for your next prompt
- **Interactive Control**: You can still queue more prompts or cancel executing tasks with `ESC` or `Ctrl+C`
- **Crash Recovery**: Automatically restarts crashed processes (where supported)
- **Idle Detection**: Optional auto-exit when the AI becomes idle
- **Named Pipe Input (Linux)**: On Linux systems, automatically creates a FIFO (named pipe) at `/tmp/agent-yes-YYYYMMDDHHMMSSXXX.stdin` for additional input streams

## Agent Clis

Install the AI CLI tool(s) you want to use:

### Claude

```bash
npm install -g @anthropic-ai/claude-code
```

Learn more: https://www.anthropic.com/claude-code

### Gemini

```bash
# Install Gemini CLI (if available)
# Check Google's documentation for installation instructions
```

### Codex

```bash
# Install Codex CLI (if available)
# Check Microsoft's documentation for installation instructions
```

### GitHub Copilot

```bash
# Install GitHub Copilot CLI
# Check GitHub's documentation for installation instructions
```

### Cursor

```bash
# Install Cursor agent CLI
# Check Cursor's documentation for installation instructions
```

### Grok

```bash
npm install -g @vibe-kit/grok-cli
```

Learn more: https://github.com/vibe-kit/grok-cli

### Auggie

```bash
npm install -g @augmentcode-inc/auggie-cli
```

Learn more: https://www.augmentcode.com/

Then install this project:

```bash
npm install agent-yes -g
```

## Usage

### Command Line Interface

```bash
claude-yes [--exit-on-idle=60s] [tool-command] [prompts]
```

#### Examples

**Claude (default):**

```bash
claude-yes -- run all tests and commit current changes
bunx claude-yes "Solve TODO.md"
```

**Other AI tools:**

```bash
# Use Codex directly
codex-yes -- refactor this function

# Use Grok directly
grok-yes -- help me with this code

# Use Copilot directly
copilot-yes -- generate unit tests

# Use Cursor directly
cursor-yes -- optimize performance

# Use Gemini directly
gemini-yes -- debug this code

# Use Auggie directly
auggie-yes -- analyze code patterns

claude-yes "help me with this code"
claude-yes "optimize performance"
```

**Auto-exit when idle (useful for automation):**

```bash
claude-yes --exit-on-idle=60s "run all tests and commit current changes"
```

**Alternative with claude-code-execute:**

```bash
claude-code-execute claude-yes "your task here"
```

### Docker Usage

You can run `agent-yes` in a Docker container with all AI CLI tools pre-installed.

**Pull the image:**

```bash
# From GitHub Container Registry (recommended)
docker pull ghcr.io/snomiao/agent-yes:latest

# Or from Docker Hub
docker pull snomiao/agent-yes:latest
```

**Basic usage:**

```bash
# Run with Claude (default)
docker run --rm -v $(pwd):/workspace -w /workspace \
  ghcr.io/snomiao/agent-yes:latest \
  -- run all tests

# Run with other AI tools
docker run --rm -v $(pwd):/workspace -w /workspace \
  ghcr.io/snomiao/agent-yes:latest \
  --cli=gemini -- debug this code
```

**Persisting credentials:**

To persist API keys and configuration across container runs, mount the config directories:

```bash
# For Claude
docker run --rm \
  -v $(pwd):/workspace \
  -v ~/.config/claude:/root/.config/claude \
  -v ~/.anthropic:/root/.anthropic \
  -w /workspace \
  ghcr.io/snomiao/agent-yes:latest \
  -- help me with this code

# For multiple AI tools (mount all config directories)
docker run --rm \
  -v $(pwd):/workspace \
  -v ~/.config:/root/.config \
  -v ~/.anthropic:/root/.anthropic \
  -v ~/.openai:/root/.openai \
  -v ~/.cursor:/root/.cursor \
  -w /workspace \
  ghcr.io/snomiao/agent-yes:latest \
  --cli=claude -- optimize performance
```

**Complete example with environment variables:**

```bash
# Pass API keys via environment variables
docker run --rm \
  -v $(pwd):/workspace \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e GOOGLE_API_KEY=$GOOGLE_API_KEY \
  -w /workspace \
  ghcr.io/snomiao/agent-yes:latest \
  -- refactor this module

# Or use an env file
docker run --rm \
  -v $(pwd):/workspace \
  --env-file .env \
  -w /workspace \
  ghcr.io/snomiao/agent-yes:latest \
  --exit-on-idle=60s -- run all tests and commit
```

**Docker Compose example:**

```yaml
version: "3.8"
services:
  agent-yes:
    image: ghcr.io/snomiao/agent-yes:latest
    volumes:
      - .:/workspace
      - ~/.config/claude:/root/.config/claude
      - ~/.anthropic:/root/.anthropic
    working_dir: /workspace
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    command: ["--", "help me solve all todos"]
```

**Available platforms:**

- `linux/amd64` (x86_64)
- `linux/arm64` (aarch64)

**Cloud deployment:**

For deploying to cloud platforms like Google Cloud Run, AWS, Azure, see [Cloud Deployment Guide](./docs/clouds.md).

### Supported CLI Tools

| Tool    | CLI Name  | Description                       | Installation/Update                                 |
| ------- | --------- | --------------------------------- | --------------------------------------------------- |
| Claude  | `claude`  | Anthropic's Claude Code (default) | `npm install -g @anthropic-ai/claude-code@latest`   |
| Gemini  | `gemini`  | Google's Gemini CLI               | `npm install -g @google/gemini-cli@latest`          |
| Codex   | `codex`   | OpenAI's Codex CLI                | `npm install -g @openai/codex-cli@latest`           |
| Copilot | `copilot` | GitHub Copilot CLI                | `npm install -g @github/copilot@latest`             |
| Cursor  | `cursor`  | Cursor agent CLI                  | See https://cursor.com/ja/docs/cli/installation     |
| Grok    | `grok`    | Vibe Kit's Grok CLI               | `npm install -g @vibe-kit/grok-cli@latest`          |
| Qwen    | `qwen`    | Alibaba's Qwen Code CLI           | `npm install -g @qwen-code/qwen-code@latest`        |
| Auggie  | `auggie`  | Augment Code's Auggie CLI         | `npm install -g @augmentcode-inc/auggie-cli@latest` |

The tool will:

1. Run the specified AI CLI tool
2. Automatically respond "Yes" to common yes/no prompts
3. Handle tool-specific patterns and responses
4. When using `--exit-on-idle` flag, automatically exit when the tool becomes idle

## CLI Tools Comparison

### Pros & Cons Analysis

#### Claude Code CLI (Anthropic)

**Pros:**

- Industry-leading performance on SWE-bench (72.5%) and Terminal-bench (43.2%)
- Advanced checkpointing feature for code state management
- Deep terminal integration with Unix philosophy support
- Enterprise-ready with AWS/GCP deployment options
- Excellent at complex refactoring and debugging tasks

**Cons:**

- Higher cost compared to alternatives ($5+ per session)
- Terminal-based interface may not suit all developers
- Closed ecosystem with limited community plugins
- Requires API subscription for full features

#### Gemini CLI (Google)

**Pros:**

- Free tier with generous limits (60 requests/min, 1,000/day)
- Fully open source (Apache 2.0 license)
- 1 million token context window
- MCP integration for extensibility
- GitHub Actions integration at no cost

**Cons:**

- Currently in preview with potential stability issues
- Shared quotas between CLI and Code Assist
- May produce factually incorrect outputs
- Limited to English language support

#### Codex CLI (OpenAI/Microsoft)

**Pros:**

- Cloud-based scalability for team collaboration
- Powers GitHub Copilot ecosystem
- Supports multimodal input (images, diagrams)
- Strong GitHub integration
- Flexible API for custom implementations

**Cons:**

- Requires more setup and technical knowledge
- Internet dependency for all operations
- Less mature/polished than competitors
- Higher computational requirements

#### Copilot CLI (GitHub)

**Pros:**

- Seamless GitHub integration
- Terminal-native development experience
- Wide language and model support
- Command explanation and suggestion features
- Enterprise policy controls available

**Cons:**

- Requires active subscription
- English-only support
- May struggle with complex/uncommon commands
- Organization admin approval needed for business users

#### Cursor CLI

**Pros:**

- Superior performance in setup and deployment
- Multi-model support from various providers
- Excellent context awareness with RAG system
- Enterprise features for CI/CD integration
- Can run multiple agents in parallel

**Cons:**

- Steeper learning curve
- UI/UX can be clunky with cramped interface
- Manual context management required
- Screen real estate limitations

#### Grok CLI (xAI/Vibe Kit)

**Pros:**

- Open source and free for basic use
- Cost-effective premium tier ($30/month)
- Real-time data access via X integration
- Strong community support
- Cross-platform compatibility

**Cons:**

- Requires API key for advanced features
- Internet dependency for AI features
- Additional setup and authentication needed
- Newer with less mature ecosystem

#### Qwen Code CLI (Alibaba)

**Pros:**

- Fully open source (Apache 2.0)
- Exceptional benchmark performance (87.9 on MultiPL-E)
- 256K-1M token context support
- No subscription required
- Enterprise-ready with full infrastructure control

**Cons:**

- Newer entrant with developing ecosystem
- Geopolitical considerations for adoption
- Less established tooling and integrations
- Regional trust and security concerns

#### Auggie CLI (Augment Code)

**Pros:**

- AI-powered code assistant with context awareness
- Supports multiple programming languages
- Real-time code suggestions and completions
- Integration with popular IDEs
- Team collaboration features

**Cons:**

- Requires subscription for full features
- Newer product with evolving feature set
- Limited documentation compared to established tools
- May require configuration for optimal performance

### Choosing the Right Tool

- **For Solo Developers:** Claude Code (complex tasks) or Grok CLI (cost-conscious)
- **For Teams:** Codex CLI (cloud collaboration) or Cursor CLI (parallel agents)
- **For Enterprises:** Claude Code (performance) or Qwen Code (self-hosted)
- **For Budget-Conscious:** Gemini CLI (free tier) or Qwen Code (open source)
- **For GitHub Users:** Copilot CLI (native integration)

<!-- TODO: add usage As lib: call await claudeYes() and it returns render result -->

## Options

- `--cli=<tool>`: Specify which AI CLI tool to use (claude, gemini, codex, copilot, cursor, grok, qwen, auggie). Defaults to `claude`.
- `--exit-on-idle=<seconds>`: Automatically exit when the AI tool becomes idle for the specified duration. Useful for automation scripts.
- `--use-skills`: Automatically discover and prepend SKILL.md headers from the directory hierarchy (walks from current directory up to git root). Multiple SKILL.md files are merged with most specific first. Particularly useful to bring Claude Skills-like context to non-Claude agents such as Codex or Gemini. Supports nested skills for monorepos.

## Advanced Features

### Named Pipe Input (Linux Only)

On Linux systems, `agent-yes` automatically creates a named pipe (FIFO) for additional input streams. This allows you to send input to the CLI from multiple sources simultaneously.

**How it works:**

- When started on Linux, a FIFO is created at `/tmp/agent-yes-YYYYMMDDHHMMSSXXX.stdin`
- The FIFO path is displayed in the console output
- You can write to this FIFO from another terminal or script
- Input from both the FIFO and standard stdin are merged together

**Example usage:**

```bash
# Terminal 1: Start the CLI
claude-yes "help me with my code"
# Output will show: [claude-yes] Created FIFO at /tmp/agent-yes-20260109123456abc.stdin

# Terminal 2: Send additional input via the FIFO
echo "also check the tests" > /tmp/agent-yes-20260109123456abc.stdin
```

This feature is useful for:

- Scripting complex interactions
- Sending input from multiple sources
- Integrating with other tools and automation systems

## Library Usage

You can also use this as a library in your Node.js projects:

```typescript
import claudeYes from "claude-yes";

// Use Claude
await claudeYes({
  prompt: "help me solve all todos in my codebase",
  cli: "claude",
  cliArgs: ["--verbose"],
  exitOnIdle: 30000, // exit after 30 seconds of idle
  continueOnCrash: true,
  logFile: "claude.log",
});

// Use other tools
await claudeYes({
  prompt: "debug this function",
  cli: "gemini",
  exitOnIdle: 60000,
});

// Use Auggie
await claudeYes({
  prompt: "analyze code patterns",
  cli: "auggie",
  exitOnIdle: 60000,
});
```

## Implementation

The tool uses `node-pty` to spawn and manage AI CLI processes, with a sophisticated pattern-matching system that:

1. **Detects Ready States**: Recognizes when each CLI tool is ready to accept input
2. **Auto-Responds**: Automatically sends "Yes" responses to common prompts
3. **Handles Fatal Errors**: Detects and responds to fatal error conditions
4. **Manages Process Lifecycle**: Handles crashes, restarts, and graceful exits

Each supported CLI has its own configuration defining:

- **Ready patterns**: Regex patterns that indicate the tool is ready for input
- **Enter patterns**: Patterns that trigger automatic "Yes" responses
- **Fatal patterns**: Patterns that indicate fatal errors requiring exit
- **Binary mapping**: Maps logical names to actual executable names
- **Argument handling**: Special argument processing (e.g., adding `--search` to Codex)

## Dependencies

- `node-pty` or `bun-pty` - For spawning and managing AI CLI processes
- `from-node-stream` - Stream processing utilities
- `sflow` - Functional stream processing
- `terminal-render` - Terminal rendering and text processing
- `phpdie` - Error handling utilities

## Inspiration

This project was inspired by: [Claude Code full auto while I sleep : r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1klk6aw/claude_code_full_auto_while_i_sleep/)

## License

MIT
