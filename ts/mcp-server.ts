import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types";
import { globalAgentRegistry } from "./agentRegistry.ts";
import { spawnAgent } from "./core/spawner.ts";
import { PidStore } from "./pidStore.ts";
import { sendMessage } from "./core/messaging.ts";
import { readFile } from "fs/promises";
import { initializeLogPaths, setupDebugLogging } from "./core/logging.ts";
import { AgentContext } from "./core/context.ts";
import { createTerminatorStream } from "./core/streamHelpers.ts";
import sflow from "sflow";

// Import config to get CLIS_CONFIG
let CLIS_CONFIG: any;

// Helper function to get terminal dimensions
function getTerminalDimensions() {
  if (!process.stdout.isTTY) return { cols: 80, rows: 24 }; // default size when not tty
  return {
    // Enforce minimum 20 columns to avoid layout issues
    cols: Math.max(20, process.stdout.columns),
    rows: process.stdout.rows,
  };
}

export async function startMcpServer() {
  // Load config
  try {
    const config = await import("../agent-yes.config.ts");
    CLIS_CONFIG = config.default.clis;
  } catch (error) {
    console.error("[MCP] Failed to load agent-yes.config.ts:", error);
    process.exit(1);
  }

  const server = new Server(
    { name: "agent-yes-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Define tools
  const tools: Tool[] = [
    {
      name: "spawn-agent",
      description: "Spawn a new AI agent with specified CLI and prompt",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Working directory for the agent",
          },
          cli: {
            type: "string",
            enum: Object.keys(CLIS_CONFIG),
            description: "AI CLI to spawn (e.g., 'claude', 'codex', 'gemini')",
          },
          prompt: {
            type: "string",
            description: "Initial prompt to send to the agent (optional)",
          },
        },
        required: ["cwd", "cli"],
      },
    },
    {
      name: "kill-agent",
      description: "Terminate a running agent by PID",
      inputSchema: {
        type: "object",
        properties: {
          pid: {
            type: "number",
            description: "Process ID of the agent to kill",
          },
        },
        required: ["pid"],
      },
    },
    {
      name: "read-stdout",
      description: "Read stdout output from an agent (live or historical)",
      inputSchema: {
        type: "object",
        properties: {
          pid: {
            type: "number",
            description: "Process ID of the agent",
          },
          tail: {
            type: "number",
            description: "Number of lines to return from the end (default: 100)",
          },
        },
        required: ["pid"],
      },
    },
    {
      name: "write-stdin",
      description: "Send a message to an agent's stdin",
      inputSchema: {
        type: "object",
        properties: {
          pid: {
            type: "number",
            description: "Process ID of the agent",
          },
          message: {
            type: "string",
            description: "Message to send to the agent",
          },
        },
        required: ["pid", "message"],
      },
    },
    {
      name: "list-agents",
      description: "List all agents in a working directory (live and historical)",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Working directory to list agents from (defaults to current directory)",
          },
        },
      },
    },
  ];

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "spawn-agent":
          return await handleSpawnAgent(args as any);
        case "kill-agent":
          return await handleKillAgent(args as any);
        case "read-stdout":
          return await handleReadStdout(args as any);
        case "write-stdin":
          return await handleWriteStdin(args as any);
        case "list-agents":
          return await handleListAgents(args as any);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      console.error(`[MCP] Error handling tool ${name}:`, error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.message || String(error) }),
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[agent-yes-mcp] Server started on stdio");
}

// Tool implementations

async function handleSpawnAgent(args: { cwd: string; cli: string; prompt?: string }) {
  const { cwd, cli, prompt } = args;

  // Validate CLI
  if (!CLIS_CONFIG[cli]) {
    throw new Error(`Unknown CLI: ${cli}. Available: ${Object.keys(CLIS_CONFIG).join(", ")}`);
  }

  const cliConf = CLIS_CONFIG[cli];

  // Prepare PTY options
  const ptyOptions = {
    name: "xterm-color",
    ...getTerminalDimensions(),
    cwd,
    env: { ...process.env, AGENT_YES_MCP: "true" },
  };

  // Spawn agent
  const shell = spawnAgent({
    cli,
    cliConf,
    cliArgs: [],
    verbose: false,
    install: false,
    ptyOptions,
  });

  // Initialize pidStore
  const pidStore = new PidStore(cwd);
  await pidStore.init();

  // Register process in pidStore (non-blocking - failures should not prevent agent from running)
  try {
    await pidStore.registerProcess({ pid: shell.pid, cli, args: [], prompt, cwd });
  } catch (error) {
    console.error(`[MCP] Failed to register process ${shell.pid}:`, error);
  }

  // Initialize log paths
  const logPaths = await initializeLogPaths(pidStore, shell.pid);
  setupDebugLogging(logPaths.debuggingLogsPath);

  // Create agent context
  const ctx = new AgentContext({
    shell,
    pidStore,
    logPaths,
    cli,
    cliConf,
    verbose: false,
    robust: false,
  });

  // Create exit promise for stream termination
  const pendingExitCode = Promise.withResolvers<number | null>();

  // Create output writer (writable is a property, not a method)
  const outputStream = sflow(createTerminatorStream(pendingExitCode.promise)).writable;
  const outputWriter = outputStream.getWriter();

  // Setup handlers
  shell.onData(async (data: string) => {
    await outputWriter.write(data);
    globalAgentRegistry.appendStdout(shell.pid, data);
  });

  shell.onExit(async ({ exitCode }: { exitCode: number | null }) => {
    globalAgentRegistry.unregister(shell.pid);
    // Update status in pidStore (non-blocking)
    try {
      await pidStore.updateStatus(shell.pid, "exited", {
        exitReason: exitCode === 0 ? "normal" : "crash",
        exitCode: exitCode ?? undefined,
      });
    } catch (error) {
      console.error(`[MCP] Failed to update status for PID ${shell.pid}:`, error);
    }
    pendingExitCode.resolve(exitCode);
  });

  // Register in registry (non-blocking)
  try {
    globalAgentRegistry.register(shell.pid, {
      pid: shell.pid,
      context: ctx,
      cwd,
      cli,
      prompt,
      startTime: Date.now(),
      stdoutBuffer: [],
    });
  } catch (error) {
    console.error(`[MCP] Failed to register agent ${shell.pid} in registry:`, error);
  }

  // Send prompt if provided
  if (prompt) {
    shell.write(prompt + "\n");
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ pid: shell.pid, status: "spawned", cli, cwd }),
      },
    ],
  };
}

async function handleKillAgent(args: { pid: number }) {
  const { pid } = args;
  const instance = globalAgentRegistry.get(pid);

  if (!instance) {
    // Return success status even if not found (idempotent operation)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "not_running", pid }),
        },
      ],
    };
  }

  // Kill the process
  instance.context.shell.kill("SIGTERM");
  globalAgentRegistry.unregister(pid);

  return {
    content: [{ type: "text", text: JSON.stringify({ status: "killed", pid }) }],
  };
}

async function handleReadStdout(args: { pid: number; tail?: number; cwd?: string }) {
  const { pid, tail = 100 } = args;
  const instance = globalAgentRegistry.get(pid);

  // Try to get from live agent first
  if (instance) {
    const lines = instance.stdoutBuffer.slice(-tail);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }

  // Fallback: read from log file
  try {
    // We need to find the log file from the pidStore
    // Try common locations
    const possibleDirs = [process.cwd(), args.cwd || process.cwd()];

    for (const dir of possibleDirs) {
      const pidStore = new PidStore(dir);
      await pidStore.init();
      const record = pidStore.getAllRecords().find((r) => r.pid === pid);

      if (record && record.logFile) {
        const content = await readFile(record.logFile, "utf8");
        const lines = content.split("\n");
        const tailedLines = lines.slice(-tail);
        return {
          content: [{ type: "text", text: tailedLines.join("\n") }],
        };
      }
    }

    // Not found - return empty output instead of error
    return {
      content: [{ type: "text", text: "" }],
    };
  } catch (error: any) {
    // Suppress error logging for cleaner output
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: `Failed to read stdout: ${error.message}` }),
        },
      ],
    };
  }
}

async function handleWriteStdin(args: { pid: number; message: string }) {
  const { pid, message } = args;
  const instance = globalAgentRegistry.get(pid);

  if (!instance) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: `Agent with PID ${pid} not found (not running)` }),
        },
      ],
    };
  }

  try {
    // Use sendMessage to properly send to agent
    await sendMessage(instance.context.messageContext, message);

    return {
      content: [{ type: "text", text: JSON.stringify({ status: "sent", pid, message }) }],
    };
  } catch (error: any) {
    // Suppress error logging for cleaner output
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: `Failed to send message: ${error.message}` }),
        },
      ],
    };
  }
}

async function handleListAgents(args: { cwd?: string }) {
  const cwd = args.cwd || process.cwd();

  // Get live agents
  const liveAgents = globalAgentRegistry
    .list()
    .filter((a) => a.cwd === cwd)
    .map((a) => ({
      pid: a.pid,
      cli: a.cli,
      cwd: a.cwd,
      status: "running",
      startTime: a.startTime,
      prompt: a.prompt,
    }));

  // Get historical agents from DB
  const pidStore = new PidStore(cwd);
  await pidStore.init();
  const dbAgents = pidStore
    .getAllRecords()
    .filter((r) => r.cwd === cwd)
    .map((r) => ({
      pid: r.pid,
      cli: r.cli,
      cwd: r.cwd,
      status: r.status,
      exitCode: r.exitCode,
      startTime: r.startedAt,
      prompt: r.prompt,
    }));

  // Merge and deduplicate (prefer live agents)
  const allAgents = [...liveAgents];
  const livePids = new Set(liveAgents.map((a) => a.pid));

  for (const dbAgent of dbAgents) {
    if (!livePids.has(dbAgent.pid)) {
      allAgents.push(dbAgent);
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ agents: allAgents, cwd }) }],
  };
}
