import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractSessionId,
  extractSessionIdFromSessionMeta,
  getAllWorkingDirectories,
  getRecentSessionsForCwd,
  getSessionForCwd,
  storeSessionForCwd,
} from "./codexSessionManager";

// Create a temporary test directory
const testDir = join(tmpdir(), "claude-yes-test-" + Date.now());
const testCodexDir = join(testDir, ".codex", "sessions");
const testConfigDir = join(testDir, ".config", "agent-yes");

// Store original environment
const originalTestHome = process.env.CLI_YES_TEST_HOME;

beforeEach(async () => {
  // Set up test directories
  await mkdir(testCodexDir, { recursive: true });
  await mkdir(testConfigDir, { recursive: true });

  // Set test home directory
  process.env.CLI_YES_TEST_HOME = testDir;
});

afterEach(async () => {
  // Clean up
  process.env.CLI_YES_TEST_HOME = originalTestHome;
  await rm(testDir, { recursive: true, force: true });
});

// Helper function to create a mock codex session file
async function createMockSessionFile(sessionData: {
  id: string;
  timestamp: string;
  cwd: string;
  git?: any;
}) {
  const year = new Date(sessionData.timestamp).getFullYear();
  const month = String(new Date(sessionData.timestamp).getMonth() + 1).padStart(2, "0");
  const day = String(new Date(sessionData.timestamp).getDate()).padStart(2, "0");

  const sessionDir = join(testCodexDir, String(year), month, day);
  await mkdir(sessionDir, { recursive: true });

  const filename = `test-session-${sessionData.id}.jsonl`;
  const filePath = join(sessionDir, filename);

  const sessionMeta = {
    timestamp: sessionData.timestamp,
    type: "session_meta",
    payload: {
      id: sessionData.id,
      timestamp: sessionData.timestamp,
      cwd: sessionData.cwd,
      originator: "codex_cli_rs",
      cli_version: "0.42.0",
      instructions: null,
      git: sessionData.git,
    },
  };

  const content = JSON.stringify(sessionMeta) + "\n";
  await writeFile(filePath, content);

  return filePath;
}

describe("codexSessionManager", () => {
  describe("extractSessionId", () => {
    it("should extract valid session IDs from output", () => {
      const output1 = "Session ID: 019a4877-5f3c-7763-b573-513cc2d5d291";
      const output2 = "Starting session 019a4877-5f3c-7763-b573-513cc2d5d291 for user";
      const output3 = "No session ID here";

      expect(extractSessionId(output1)).toBe("019a4877-5f3c-7763-b573-513cc2d5d291");
      expect(extractSessionId(output2)).toBe("019a4877-5f3c-7763-b573-513cc2d5d291");
      expect(extractSessionId(output3)).toBeNull();
    });
  });

  describe("extractSessionIdFromSessionMeta", () => {
    it("should extract session ID from valid session metadata", () => {
      const sessionContent = JSON.stringify({
        timestamp: "2025-11-03T06:46:14.123Z",
        type: "session_meta",
        payload: {
          id: "019a4877-5f3c-7763-b573-513cc2d5d291",
          cwd: "/test/path",
        },
      });

      expect(extractSessionIdFromSessionMeta(sessionContent)).toBe(
        "019a4877-5f3c-7763-b573-513cc2d5d291",
      );
    });

    it("should fall back to regex extraction for invalid JSON", () => {
      const invalidContent = "Invalid JSON but contains 019a4877-5f3c-7763-b573-513cc2d5d291";

      expect(extractSessionIdFromSessionMeta(invalidContent)).toBe(
        "019a4877-5f3c-7763-b573-513cc2d5d291",
      );
    });
  });

  describe("session storage and retrieval", () => {
    it("should store and retrieve session IDs for directories", async () => {
      const cwd = "/test/project";
      const sessionId = "019a4877-5f3c-7763-b573-513cc2d5d291";

      await storeSessionForCwd(cwd, sessionId);
      const retrieved = await getSessionForCwd(cwd);

      expect(retrieved).toBe(sessionId);
    });

    it("should return null for non-existent directories", async () => {
      const result = await getSessionForCwd("/non/existent");
      expect(result).toBeNull();
    });
  });

  describe("codex session file parsing", () => {
    it("should read sessions from actual codex files", async () => {
      const sessionData = {
        id: "019a4877-5f3c-7763-b573-513cc2d5d291",
        timestamp: "2025-11-03T06:46:14.123Z",
        cwd: "/v1/code/snomiao/claude-yes/tree/main",
        git: {
          commit_hash: "abc123",
          branch: "main",
          repository_url: "git@github.com:snomiao/claude-yes.git",
        },
      };

      await createMockSessionFile(sessionData);

      const retrieved = await getSessionForCwd(sessionData.cwd);
      expect(retrieved).toBe(sessionData.id);
    });

    it("should get recent sessions for a directory", async () => {
      const cwd = "/test/project";
      const sessions = [
        {
          id: "session-1",
          timestamp: "2025-11-03T10:00:00.000Z",
          cwd,
        },
        {
          id: "session-2",
          timestamp: "2025-11-03T09:00:00.000Z",
          cwd,
        },
        {
          id: "session-3",
          timestamp: "2025-11-03T08:00:00.000Z",
          cwd,
        },
      ];

      for (const session of sessions) {
        await createMockSessionFile(session);
      }

      const recent = await getRecentSessionsForCwd(cwd, 2);
      expect(recent).toHaveLength(2);
      expect(recent[0]!.id).toBe("session-1"); // Most recent first
      expect(recent[1]!.id).toBe("session-2");
    });

    it("should get all working directories with counts", async () => {
      const sessions = [
        {
          id: "session-1",
          timestamp: "2025-11-03T10:00:00.000Z",
          cwd: "/project-a",
        },
        {
          id: "session-2",
          timestamp: "2025-11-03T09:00:00.000Z",
          cwd: "/project-a",
        },
        {
          id: "session-3",
          timestamp: "2025-11-03T08:00:00.000Z",
          cwd: "/project-b",
        },
      ];

      for (const session of sessions) {
        await createMockSessionFile(session);
      }

      const directories = await getAllWorkingDirectories();
      expect(directories).toHaveLength(2);

      const projectA = directories.find((d) => d.cwd === "/project-a");
      const projectB = directories.find((d) => d.cwd === "/project-b");

      expect(projectA?.count).toBe(2);
      expect(projectB?.count).toBe(1);

      // Should be sorted by last session time (most recent first)
      expect(directories[0]!.cwd).toBe("/project-a");
    });
  });

  describe("fallback behavior", () => {
    it("should fall back to stored mapping when no codex files exist", async () => {
      const cwd = "/fallback/test";
      const sessionId = "fallback-session-id";

      // Store in mapping but don't create codex file
      await storeSessionForCwd(cwd, sessionId);

      const retrieved = await getSessionForCwd(cwd);
      expect(retrieved).toBe(sessionId);
    });

    it("should prefer codex files over stored mapping", async () => {
      const cwd = "/preference/test";
      const storedSessionId = "stored-session";
      const codexSessionId = "codex-session";

      // Store in mapping first
      await storeSessionForCwd(cwd, storedSessionId);

      // Create codex file with different session ID
      await createMockSessionFile({
        id: codexSessionId,
        timestamp: "2025-11-03T10:00:00.000Z",
        cwd,
      });

      const retrieved = await getSessionForCwd(cwd);
      expect(retrieved).toBe(codexSessionId); // Should prefer codex file
    });
  });
});
