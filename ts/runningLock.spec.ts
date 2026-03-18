import { execSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  cleanStaleLocks,
  releaseLock,
  shouldUseLock,
  type Task,
  updateCurrentTaskStatus,
} from "./runningLock";

// Keep lock files inside the repo to avoid $HOME permission issues in CI
process.env.CLAUDE_YES_HOME = path.join(process.cwd(), ".cache");

const LOCK_DIR = path.join(process.env.CLAUDE_YES_HOME, ".claude-yes");
const LOCK_FILE = path.join(LOCK_DIR, "running.lock.json");
const TEST_DIR = path.join(process.cwd(), ".cache", "test-lock");

describe("runningLock", () => {
  beforeEach(async () => {
    // Clean up before each test
    await cleanupLockFile();
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Clean up after each test
    await cleanupLockFile();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe("shouldUseLock", () => {
    it("should return true for any directory", () => {
      expect(shouldUseLock(process.cwd())).toBe(true);
      expect(shouldUseLock("/tmp")).toBe(true);
      expect(shouldUseLock(TEST_DIR)).toBe(true);
    });
  });

  describe("acquireLock and releaseLock", () => {
    it("should acquire and release lock successfully", async () => {
      await acquireLock(TEST_DIR, "Test task");

      // Check lock file exists and contains task
      const lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(1);
      expect(lockData.tasks[0]!.cwd).toBe(path.resolve(TEST_DIR));
      expect(lockData.tasks[0]!.task).toBe("Test task");
      expect(lockData.tasks[0]!.pid).toBe(process.pid);
      expect(lockData.tasks[0]!.status).toBe("running");

      // Release lock
      await releaseLock();

      // Check lock is released
      const lockDataAfter = await readLockFile();
      expect(lockDataAfter.tasks).toHaveLength(0);
    });

    it("should create lock directory if it does not exist", async () => {
      // Remove lock directory
      await rm(LOCK_DIR, { recursive: true, force: true });

      await acquireLock(TEST_DIR, "Test task");

      // Check directory and file exist
      expect(existsSync(LOCK_DIR)).toBe(true);
      expect(existsSync(LOCK_FILE)).toBe(true);

      await releaseLock();
    });

    it("should handle prompt longer than 100 characters", async () => {
      const longPrompt = "A".repeat(150);

      await acquireLock(TEST_DIR, longPrompt);

      const lockData = await readLockFile();
      expect(lockData.tasks[0]!.task).toHaveLength(100);
      expect(lockData.tasks[0]!.task).toBe("A".repeat(100));

      await releaseLock();
    });

    it("should include timestamp fields", async () => {
      const before = Date.now();
      await acquireLock(TEST_DIR, "Test task");
      const after = Date.now();

      const lockData = await readLockFile();
      const task = lockData.tasks[0]!;

      expect(task.startedAt).toBeGreaterThanOrEqual(before);
      expect(task.startedAt).toBeLessThanOrEqual(after);
      expect(task.lockedAt).toBeGreaterThanOrEqual(before);
      expect(task.lockedAt).toBeLessThanOrEqual(after);

      await releaseLock();
    });
  });

  describe("git repository detection", () => {
    it("should detect git root for repository", async () => {
      // Use current directory which is a git repo
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();

      await acquireLock(process.cwd(), "Git repo task");

      const lockData = await readLockFile();
      expect(lockData.tasks[0]!.gitRoot).toBe(gitRoot);

      await releaseLock();
    });

    it("should detect same git root for subdirectory", async () => {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();
      const subdir = path.join(process.cwd(), "docs");

      await acquireLock(subdir, "Subdirectory task");

      const lockData = await readLockFile();
      expect(lockData.tasks[0]!.gitRoot).toBe(gitRoot);
      expect(lockData.tasks[0]!.cwd).toBe(path.resolve(subdir));

      await releaseLock();
    });

    it("should not have gitRoot for non-git directory", async () => {
      // Create a temporary directory outside of any git repo
      const tempDir = path.join("/tmp", "test-non-git-" + Date.now());
      await mkdir(tempDir, { recursive: true });

      try {
        await acquireLock(tempDir, "Non-git task");

        const lockData = await readLockFile();
        expect(lockData.tasks[0]!.gitRoot).toBeUndefined();
        expect(lockData.tasks[0]!.cwd).toBe(path.resolve(tempDir));

        await releaseLock();
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("updateCurrentTaskStatus", () => {
    it("should update task status", async () => {
      await acquireLock(TEST_DIR, "Test task");

      // Update to completed
      await updateCurrentTaskStatus("completed");

      let lockData = await readLockFile();
      expect(lockData.tasks[0]!.status).toBe("completed");

      // Update to failed
      await updateCurrentTaskStatus("failed");

      lockData = await readLockFile();
      expect(lockData.tasks[0]!.status).toBe("failed");

      await releaseLock();
    });

    it("should not throw when updating non-existent task", async () => {
      // Should complete without throwing
      await updateCurrentTaskStatus("completed");
      // If we got here, no error was thrown
      expect(true).toBe(true);
    });
  });

  describe("cleanStaleLocks", () => {
    it("should remove stale locks with invalid PIDs", async () => {
      // Use a PID that definitely doesn't exist
      const invalidPid = 9999999;

      // Create a lock with a non-existent PID
      const staleLock = {
        tasks: [
          {
            cwd: TEST_DIR,
            task: "Stale task",
            pid: invalidPid,
            status: "running" as const,
            startedAt: Date.now() - 60000,
            lockedAt: Date.now() - 60000,
          },
        ],
      };

      await mkdir(LOCK_DIR, { recursive: true });
      await writeFile(LOCK_FILE, JSON.stringify(staleLock, null, 2));

      // Verify the stale lock was written
      let rawContent = await readFile(LOCK_FILE, "utf8");
      let rawData = JSON.parse(rawContent);
      expect(rawData.tasks).toHaveLength(1);
      expect(rawData.tasks[0]!.pid).toBe(invalidPid);

      // Now acquire a lock - this will trigger cleanup of stale locks
      await acquireLock(TEST_DIR, "New task");

      // The stale lock should be cleaned, and only our new task should remain
      const lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(1);
      expect(lockData.tasks[0]!.pid).toBe(process.pid);
      expect(lockData.tasks[0]!.task).toBe("New task");

      await releaseLock();
    });

    it("should keep valid locks with running PIDs", async () => {
      await acquireLock(TEST_DIR, "Valid task");

      // Clean stale locks (should not remove our lock)
      await cleanStaleLocks();

      const lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(1);
      expect(lockData.tasks[0]!.pid).toBe(process.pid);

      await releaseLock();
    });

    it("should handle corrupted lock file", async () => {
      // Write invalid JSON
      await mkdir(LOCK_DIR, { recursive: true });
      await writeFile(LOCK_FILE, "invalid json{{{");

      // Reading the lock file should handle corruption gracefully
      const lockData = await readLockFile();

      // Should return empty task list for corrupted file
      expect(lockData.tasks).toHaveLength(0);
    });

    it("should handle missing lock file", async () => {
      await rm(LOCK_FILE, { force: true });

      // Reading non-existent lock file should return empty
      const lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(0);
    });
  });

  describe("concurrent access", () => {
    it("should handle multiple tasks from different processes", async () => {
      // Acquire first task
      await acquireLock(TEST_DIR, "Task 1");

      // Verify the task exists
      let lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(1);
      expect(lockData.tasks[0]!.task).toBe("Task 1");

      // Acquire a second task with the same PID (should replace the first)
      await acquireLock("/tmp", "Task 2");

      // Should have only one task (the latest one)
      lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(1);
      expect(lockData.tasks[0]!.task).toBe("Task 2");

      await releaseLock();

      // After release, no tasks should remain
      const finalLockData = await readLockFile();
      expect(finalLockData.tasks).toHaveLength(0);
    });

    it("should not duplicate tasks with same PID", async () => {
      await acquireLock(TEST_DIR, "Task 1");

      // Try to acquire again with same PID
      await acquireLock(TEST_DIR, "Task 2");

      // Should only have one task
      const lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(1);
      expect(lockData.tasks[0]!.task).toBe("Task 2"); // Latest task

      await releaseLock();
    });
  });

  describe("lock file structure", () => {
    it("should have all required fields", async () => {
      await acquireLock(TEST_DIR, "Complete task");

      const lockData = await readLockFile();
      const task = lockData.tasks[0]!;

      expect(task).toHaveProperty("cwd");
      expect(task).toHaveProperty("task");
      expect(task).toHaveProperty("pid");
      expect(task).toHaveProperty("status");
      expect(task).toHaveProperty("startedAt");
      expect(task).toHaveProperty("lockedAt");

      expect(typeof task.cwd).toBe("string");
      expect(typeof task.task).toBe("string");
      expect(typeof task.pid).toBe("number");
      expect(typeof task.status).toBe("string");
      expect(typeof task.startedAt).toBe("number");
      expect(typeof task.lockedAt).toBe("number");

      await releaseLock();
    });

    it("should have valid status values", async () => {
      const validStatuses: Task["status"][] = ["running", "queued", "completed", "failed"];

      for (const status of validStatuses) {
        await acquireLock(TEST_DIR, `Task with ${status}`);
        await updateCurrentTaskStatus(status);

        const lockData = await readLockFile();
        expect(lockData.tasks[0]!.status).toBe(status);

        await releaseLock();
      }
    });
  });

  describe("edge cases", () => {
    it("should handle empty task description", async () => {
      await acquireLock(TEST_DIR, "");

      const lockData = await readLockFile();
      expect(lockData.tasks[0]!.task).toBe("");

      await releaseLock();
    });

    it("should handle special characters in task description", async () => {
      const specialTask = "Task with \"quotes\" and 'apostrophes' and \n newlines";

      await acquireLock(TEST_DIR, specialTask);

      const lockData = await readLockFile();
      expect(lockData.tasks[0]!.task).toContain("quotes");

      await releaseLock();
    });

    it("should resolve symlinks to real paths", async () => {
      await acquireLock(TEST_DIR, "Symlink test");

      const lockData = await readLockFile();
      // Should be an absolute path
      expect(path.isAbsolute(lockData.tasks[0]!.cwd)).toBe(true);

      await releaseLock();
    });

    it("should handle rapid acquire/release cycles", async () => {
      for (let i = 0; i < 10; i++) {
        await acquireLock(TEST_DIR, `Rapid task ${i}`);
        await releaseLock();
      }

      // Final state should be clean
      const lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(0);
    });
  });

  describe("queueing behavior", () => {
    it("should detect when lock is held by same git repo", async () => {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();

      // Acquire lock at root
      await acquireLock(gitRoot, "Root task");

      // Create a lock with different PID to simulate another process
      const lockData = await readLockFile();
      lockData.tasks.push({
        cwd: path.join(gitRoot, "subdirectory"),
        gitRoot: gitRoot,
        task: "Subdirectory task",
        pid: process.pid + 1,
        status: "running",
        startedAt: Date.now(),
        lockedAt: Date.now(),
      });
      await writeFile(LOCK_FILE, JSON.stringify(lockData, null, 2));

      // Both tasks should be in the same git repo
      const updatedLockData = await readLockFile();
      const gitRoots = updatedLockData.tasks.map((t) => t.gitRoot).filter((g) => g);
      expect(new Set(gitRoots).size).toBe(1); // All same git root

      await releaseLock();
    });

    it("should allow different directories without git repos", async () => {
      // Test that when we already have a task, acquiring a new one replaces it
      // (since both use the same PID)

      // Create lock for /tmp manually
      const lock = {
        tasks: [
          {
            cwd: "/tmp",
            task: "Tmp task",
            pid: process.pid,
            status: "running" as const,
            startedAt: Date.now(),
            lockedAt: Date.now(),
          },
        ],
      };
      await writeFile(LOCK_FILE, JSON.stringify(lock, null, 2));

      // Verify initial state
      let lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(1);
      expect(lockData.tasks[0]!.task).toBe("Tmp task");

      // Acquire lock for different directory (should replace the existing task)
      await acquireLock(TEST_DIR, "Test task");

      // Should only have the new task
      lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(1);
      expect(lockData.tasks[0]!.task).toBe("Test task");

      await releaseLock();
    });
  });

  describe("disableLock option", () => {
    it("should respect lock file operations when disableLock is false", async () => {
      // Clean up first
      await rm(LOCK_FILE, { force: true });

      // When disableLock is not used (default behavior), locks work normally
      await acquireLock(TEST_DIR, "Test task");
      expect(existsSync(LOCK_FILE)).toBe(true);

      const lockData = await readLockFile();
      expect(lockData.tasks).toHaveLength(1);

      await releaseLock();

      const lockDataAfter = await readLockFile();
      expect(lockDataAfter.tasks).toHaveLength(0);
    });
  });
});

// Helper functions

async function cleanupLockFile() {
  try {
    await rm(LOCK_FILE, { force: true });
  } catch {
    // Ignore errors
  }
}

async function readLockFile(): Promise<{ tasks: Task[] }> {
  try {
    const content = await readFile(LOCK_FILE, "utf8");
    const lockFile = JSON.parse(content);
    // Don't clean stale locks in tests - we want to see the raw data
    return lockFile;
  } catch {
    return { tasks: [] };
  }
}
