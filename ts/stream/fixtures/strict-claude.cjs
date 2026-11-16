#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const argv = process.argv.slice(2);
const jsonInput =
  argv.includes("stream-json") &&
  argv.some((arg) => arg === "--input-format" || arg === "--input-format=stream-json");
if (!jsonInput) {
  process.stderr.write("Fixture requires JSON input\n");
  process.exit(2);
}
let turn = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("Invalid stream input JSON\n");
    process.exit(2);
  }
  if (message.type === "control_request") return;
  if (
    message.type !== "user" ||
    message.message?.role !== "user" ||
    typeof message.message.content !== "string"
  ) {
    process.stderr.write("Invalid user message\n");
    process.exit(2);
  }
  if (process.env.AY_STREAM_TEST_CAPTURE)
    fs.appendFileSync(process.env.AY_STREAM_TEST_CAPTURE, JSON.stringify(message) + "\n");
  console.log(
    JSON.stringify({ type: "system", subtype: "init", session_id: "example", model: "example" }),
  );
  console.log(JSON.stringify(message));
  console.log(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: message.message.content }] },
    }),
  );
  console.log(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: ++turn * 0.001,
    }),
  );
  if (message.message.content === "finish") setTimeout(() => process.exit(0), 25);
});
