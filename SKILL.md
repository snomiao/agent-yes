# CLI Yes Automation Skill

A skill for automating AI CLI tool interactions by handling common prompts and managing continuous operation.

## Description

This skill helps you work with the `agent-yes` wrapper tool, which automates interactions with various AI CLI tools (Claude, Gemini, Codex, Copilot, Cursor, Grok, Qwen) by automatically responding to common prompts and keeping the tools running continuously.

## When to Use This Skill

- Setting up automated AI CLI workflows
- Configuring continuous operation with AI assistants
- Implementing auto-response patterns for yes/no prompts
- Managing crash recovery and idle detection
- Running AI CLI tools in automation scripts or CI/CD pipelines

## Key Capabilities

### Multi-CLI Support

Works with multiple AI coding assistants:

- Claude Code (Anthropic) - Industry-leading performance
- Gemini CLI (Google) - Free tier with generous limits
- Codex CLI (OpenAI/Microsoft) - Cloud-based collaboration
- Copilot CLI (GitHub) - Seamless GitHub integration
- Cursor CLI - Multi-model support with RAG
- Grok CLI (xAI) - Real-time data access
- Qwen Code CLI (Alibaba) - Open source, high performance

### Automation Features

- **Auto-Response**: Automatically responds "Yes" to common prompts
- **Continuous Operation**: Keeps AI running until task completion
- **Crash Recovery**: Automatic process restart on crashes
- **Idle Detection**: Optional auto-exit when AI becomes idle
- **Interactive Control**: Queue prompts or cancel with ESC/Ctrl+C

## Usage Examples

### Basic Command Line Usage

```bash
# Use Claude (default)
agent-yes claude -- run all tests and commit current changes
bunx agent-yes claude "Solve TODO.md"

# Use other AI tools
agent-yes codex -- refactor this function
agent-yes grok -- help me with this code
agent-yes copilot -- generate unit tests
agent-yes cursor -- optimize performance
agent-yes gemini -- debug this code
agent-yes qwen -- implement new feature

# Auto-exit when idle (for automation)
agent-yes claude --exit-on-idle=60s "run all tests and commit current changes"
```

### Library Usage in Node.js

```typescript
import cliYes from "agent-yes";

// Use Claude
await cliYes({
  prompt: "help me solve all todos in my codebase",
  cli: "claude",
  cliArgs: ["--verbose"],
  exitOnIdle: 30000, // exit after 30 seconds of idle
  continueOnCrash: true,
  logFile: "claude.log",
});

// Use other tools
await cliYes({
  prompt: "debug this function",
  cli: "gemini",
  exitOnIdle: 60000,
});
```

## Channels — AI ↔ Human Chat (`ay ch` / `AyChannel`)

`agent-yes` includes **channels**: local-first, end-to-end encrypted threads where
AI agents and humans talk on a topic, **peer-to-peer over WebRTC**. No server ever
stores a message — every participant (CLI or browser) keeps a full CRDT replica, so
concurrent messages merge automatically and offline peers catch up on reconnect.

### When to use

- Let a human talk to a running agent (or a fleet of agents) from a web page or another machine
- Agent-to-agent coordination on a shared topic
- A drop-in chat widget for any site, backed by your agents

### CLI

```bash
ay ch mk standup                 # create a channel; prints an invite link
ay ch join <invite-link>         # join from someone else's invite
ay ch send standup "build is green"
ay ch read standup               # print the thread (from the local replica)
ay ch tail standup -f            # follow
ay ch sync standup               # hold the WebRTC mesh: live send/receive (run backgrounded)
ay ch pipe standup               # bridge stdin→send and inbound→stdout (script an agent into a channel)
ay ch embed standup              # print an HTML snippet embedding a floating chat widget
```

Messages persist per project at `<cwd>/.agent-yes/ch-<id>.jsonl`. `send`/`read`/`tail`
are pure-local; run `ay ch sync` (foreground or backgrounded) to actually deliver over
the mesh — it coordinates through the replica file, so no daemon or IPC is needed.

### Browser library

```ts
import AyChannel from "agent-yes/channels";

const ch = new AyChannel("ay://ch/s.agent-yes.com/<room>#e1.<secret>");
await ch.start();
ch.on("message", async () => render(await ch.messages()));
await ch.send("hi from the browser");

ch.mount();          // floating chat window (Shadow DOM); or ch.mount(el) to embed in an element
```

The browser client joins the **same mesh** as any `ay ch sync` peer, persists to
LocalStorage, and renders a self-contained floating widget — so an agent and a human
can talk on the same page. For a no-bundler embed, `ay ch embed <topic>` prints a
`<script type="module">` snippet that loads the widget from the console host.

### Security

The channel secret (carried in the invite link) **is** the membership credential:
anyone who holds it can read and post. The signaling server only ever sees a one-way
`HKDF(secret)` token — message contents and the AES keys never leave the endpoints.
Only share an invite (or embed the widget) with an audience you mean to admit.

## Configuration Options

- `--cli=<tool>`: Specify AI CLI tool (claude, gemini, codex, copilot, cursor, grok, qwen)
- `--exit-on-idle=<duration>`: Auto-exit after specified idle time (e.g., "60s", "5m")
- Custom CLI args can be passed through for tool-specific options

## Security Considerations

⚠️ **Important**: Only run on trusted repositories. This tool:

- Automatically responds to prompts without user confirmation
- Can execute commands automatically
- May be vulnerable to prompt injection attacks in malicious code/files

Always review repositories before running automated tools.

## Implementation Details

Uses `node-pty` or `bun-pty` to manage AI CLI processes with:

- **Pattern matching**: Detects ready states, prompts, and errors
- **Auto-response system**: Sends "Yes" to common prompts
- **Process lifecycle management**: Handles crashes and graceful exits
- **Tool-specific configurations**: Custom patterns for each CLI

## Installation

```bash
# Install the wrapper tool globally
npm install agent-yes -g

# Install your preferred AI CLI
npm install -g @anthropic-ai/claude-code  # Claude
npm install -g @vibe-kit/grok-cli         # Grok
# See documentation for other CLI installation
```

## Best Practices

1. **Start small**: Test with simple tasks before complex automation
2. **Use idle timeout**: Set `--exit-on-idle` for automated scripts
3. **Review output**: Check logs and results regularly
4. **Trust repositories only**: Never run on untrusted code
5. **Choose the right CLI**: Match tool to task requirements
   - Complex tasks → Claude Code
   - Budget-conscious → Gemini or Qwen
   - GitHub integration → Copilot
   - Team collaboration → Codex or Cursor

## Resources

- GitHub: https://github.com/snomiao/claude-yes
- Claude Code: https://www.anthropic.com/claude-code
- Issue Tracker: https://github.com/snomiao/claude-yes/issues

## License

MIT - See project repository for details
