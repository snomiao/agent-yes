import { describe, expect, it } from "bun:test";
import { extractSessionId, extractSessionIdFromSessionMeta } from "./resume/codexSessionManager";

describe("Session Extraction Test", () => {
  it("should extract session IDs from various codex output formats", async () => {
    console.log("\n=== Session ID Extraction Test ===");

    // Test different formats where session IDs might appear
    const testCases = [
      {
        name: "Direct UUID in output",
        output: "Session started with ID: 0199e659-0e5f-7843-8876-5a65c64e77c0",
        expected: "0199e659-0e5f-7843-8876-5a65c64e77c0",
      },
      {
        name: "UUID in brackets",
        output: "Using session [0199e659-0e5f-7843-8876-5a65c64e77c0] for this conversation",
        expected: "0199e659-0e5f-7843-8876-5a65c64e77c0",
      },
      {
        name: "Mixed case UUID",
        output: "SESSION_ID: 0199E659-0E5F-7843-8876-5A65C64E77C0",
        expected: "0199E659-0E5F-7843-8876-5A65C64E77C0",
      },
      {
        name: "No UUID present",
        output: "Welcome to codex! Type your message and press enter.",
        expected: null,
      },
      {
        name: "Multiple UUIDs (should get first)",
        output:
          "Old: 1111e659-0e5f-7843-8876-5a65c64e77c0 New: 2222e659-0e5f-7843-8876-5a65c64e77c0",
        expected: "1111e659-0e5f-7843-8876-5a65c64e77c0",
      },
    ];

    for (const testCase of testCases) {
      console.log(`Testing: ${testCase.name}`);
      const result = extractSessionId(testCase.output);
      console.log(`  Input: ${testCase.output}`);
      console.log(`  Expected: ${testCase.expected}`);
      console.log(`  Got: ${result}`);
      expect(result).toBe(testCase.expected);
    }

    console.log("✅ All session extraction tests passed!\n");
  });

  it("should extract session ID from session metadata JSON", async () => {
    console.log("\n=== Session Metadata Extraction Test ===");

    const sessionMetaJson = `{"timestamp":"2025-10-15T05:30:20.265Z","type":"session_meta","payload":{"id":"0199e659-0e5f-7843-8876-5a65c64e77c0","timestamp":"2025-10-15T05:30:20.127Z","cwd":"/v1/code/project","originator":"codex_cli_rs"}}
{"timestamp":"2025-10-15T05:30:20.415Z","type":"response_item","payload":{"type":"message","role":"user"}}`;

    const sessionId = extractSessionIdFromSessionMeta(sessionMetaJson);
    console.log(`Extracted session ID: ${sessionId}`);
    expect(sessionId).toBe("0199e659-0e5f-7843-8876-5a65c64e77c0");

    console.log("✅ Session metadata extraction test passed!\n");
  });

  it("should demonstrate session tracking workflow", async () => {
    console.log("\n=== Session Tracking Workflow Demo ===");

    // Simulate codex output that would contain session information
    const mockCodexOutputs = [
      {
        directory: "logs/cwd1",
        output: "Starting new conversation... Session ID: aaaa1111-2222-3333-4444-bbbbccccdddd",
      },
      {
        directory: "logs/cwd2",
        output: "Resuming session... Using ID: bbbb2222-3333-4444-5555-ccccddddeeee",
      },
    ];

    console.log("Simulating session capture from codex output:");

    for (const mock of mockCodexOutputs) {
      const sessionId = extractSessionId(mock.output);
      console.log(`Directory: ${mock.directory}`);
      console.log(`Output: ${mock.output}`);
      console.log(`Captured Session ID: ${sessionId}`);
      console.log("---");

      expect(sessionId).toBeTruthy();
      expect(sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
    }

    console.log("✅ Workflow demonstration completed!\n");
  });
});
