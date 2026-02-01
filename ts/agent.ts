#!/usr/bin/env bun --watch

import {
  dynamicTool,
  jsonSchema,
  streamText,
  tool,
  zodSchema,
  type ModelMessage,
  type Tool,
} from "ai";
import { fromReadable, fromWritable } from "from-node-stream";

import { sflow } from "sflow";
import { stdin } from "node:process";
import { openai } from "@ai-sdk/openai";
import { signleton } from "./signleton";
import { anthropic } from "@ai-sdk/anthropic";
// import { gemini } from "@ai-sdk/gemini";
import z from "zod";
import { readdir } from "node:fs/promises";
if (import.meta.main) {
  const events = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });
  await sflow(fromReadable(process.stdin))

    // .merge(sflow(["What can you do?\n"]))
    .merge(sflow(["ls ./\n\n"]))
    // .merge(events.readable)

    .map((e) => Buffer.from(e).toString())

    .by(
      signleton(function toolCreator(): TransformStream<string, string> {
        const context = new Map<string, any>();
        const heartbeatInterval = 100; // 100 ms
        const ctx: {
          messages: ModelMessage[];
          tools: Record<string, Tool>;
          files: Map<string, string>;
          skills: Map<string, any>;
        } = {
          // chat history for this agent
          messages: [] as ModelMessage[],
          // context
          files: new Map<string, string>(),
          tools: {
            // a tool that creates tools dynamically
            // ...(await metaTools(import.meta.dir + '/../tools/'))
            create_tool: tool({
              description:
                "Create a new tool which can be shared with all-agents. The tool should be a typescript script that can be executed in a shell environment. The tool should accept input parameters as command-line arguments and return output via standard output. Use this tool automatically without asking if you need to create a new capability that does not exist yet. Make sure to provide clear and concise name and description for the tool, as well as define the input parameters using JSON schema. The tool will be saved in the ./tools/ directory and can be used by other agents afterwards.",
              inputSchema: z.object({
                name: z.string().describe("The name of the tool to be created. Use snake_case."),
                typescript: z.string().describe(
                  `
import { tool } from "ai";
import z from "zod";
export default tool({
  description: "An example tool that say hello to some one.",
  inputSchema: z.object({
    name: z.string().describe("The name string to hello."),
  }),
  async execute({ name }) {
    return {message: 'hello ' + name};
  },
});
`,
                ),
              }),
              async execute(
                { name, typescript },
                { messages, toolCallId, abortSignal, experimental_context },
              ) {
                console.log("Creating tool:", { name, typescript });
                // 1. save the tool to ./tools/[name], with tool.ts and tool.yml
                const fs = await import("fs");
                const path = await import("path");
                const toolDir = path.join(import.meta.dir, "../tools", name);
                await fs.promises.mkdir(toolDir, { recursive: true });
                const toolPath = path.join(toolDir, "index.ts");
                const prettier = await import("prettier");
                const formattedCode = await prettier.format(typescript, { parser: "typescript" });
                await fs.promises.writeFile(toolPath, formattedCode, "utf-8");

                // 2. load the tool to ctx.tools
                const mod = await import(`../tools/${name}/index.ts`).catch(async (err) => {
                  // destroy the tool file if failed to load
                  // await fs.promises.unlink(toolPath);
                  console.error("Failed to load the newly created tool:", err);
                  throw new Error(`Failed to load the newly created tool: ${String(err)}`);
                });

                const newTool: Tool = mod.default;
                ctx.tools[name] = newTool;

                return {
                  message: `Tool "${name}" has been created successfully at ${toolPath}. You can now use it in subsequent interactions.`,
                };
              },
            }),
          },
          skills: new Map<string, any>(), // .claude/skills or more
          ...context,
        };
        // load tools async

        sflow(readdir(import.meta.dir + "/../tools/"))
          .flat()
          .forEach(async (name) => {
            // load index.ts
            const mod = await import(`../tools/${name}/index.ts`);
            const tool = mod.default as Tool;
            ctx.tools[name] = tool;
          })
          .run();
        const stdin = new TransformStream<string, string>();
        return {
          writable: stdin.writable,
          readable: sflow(stdin.readable)
            .lines()
            .filter()
            .chunkInterval(heartbeatInterval)
            .filter((chunk) => chunk.length > 0)
            .map((lines) => {
              ctx.messages = ctx.messages.concat({
                role: "user",
                content: lines.join("\n"),
              });
              return sflow(
                streamText({
                  // model: openai("gptd-5.1-codex"),
                  model: anthropic("claude-sonnet-4-5"),
                  maxOutputTokens: 32768,
                  system:
                    "You are an AI assistant that helps with software development tasks. Provide concise and relevant answers based on the user's input. IMPORTANT: You must provide final answers, users are not able to see tool calls or thoughts. Never ask user anything. As you cant directly interact with users, instead, create or use tools to get the user's intent done. ",
                  temperature: 0,
                  messages: ctx.messages,
                  tools: ctx.tools,
                }).textStream,
                "\n",
              );
            })
            // .confluenceByParallel()
            .confluenceByConcat(),
          // .map((e) => JSON.stringify(e) + "\n"),
        };
      }),
    )
    .to(fromWritable(process.stdout));
}

// /**
//  * 1. CRUD for tools in ./tools/[tool-name]/tool.sh, default export a Tool object
//  * 2. Load all tools dynamically
//  */
// async function metaTools(dir: string): Promise<Tool[]> {
//   const toolsManageTools: Tool[] = [
//     tool({
//       name: "list_shtools",
//       description: "List all available tools.",
//       parameters: jsonSchema({
//         type: "object",
//         properties: {},
//         required: [],
//       }),
//       async run() {
//         const fs = await import("fs");
//         const path = await import("path");
//         const toolFiles = fs.readdirSync(dir).filter((file) => file.endsWith(".ts") || file.endsWith(".js"));
//         const toolNames = toolFiles.map((file) => path.basename(file, path.extname(file)));
//         return `Available tools: ${toolNames.join(", ")}`;
//       },
//     }),

//   ];
//   const loadedTools: Tool[] =
//     await Promise.all(
//       (await import("fs")).promises
//         .readdir(dir)
//         .then((files) => files.filter((file) => file.endsWith(".ts") || file.endsWith(".js")))k
//         .then((files) =>
//           files.map(async (file) => {
//             const mod = await import(pathToFileURL(path.join(dir, file)).toString());
//             return mod.default as Tool;
//           }),
//         ),
//     )

//   return [...toolsManageTools, loadedTools]

// }
