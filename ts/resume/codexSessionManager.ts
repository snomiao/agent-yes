import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";

// Allow overriding for testing
const getSessionsFile = () =>
  process.env.CLI_YES_TEST_HOME
    ? path.join(process.env.CLI_YES_TEST_HOME, ".config", "agent-yes", "codex-sessions.json")
    : path.join(homedir(), ".config", "agent-yes", "codex-sessions.json");

const getCodexSessionsDir = () =>
  process.env.CLI_YES_TEST_HOME
    ? path.join(process.env.CLI_YES_TEST_HOME, ".codex", "sessions")
    : path.join(homedir(), ".codex", "sessions");

interface CodexSessionMap {
  [cwd: string]: {
    sessionId: string;
    lastUsed: string; // ISO timestamp
  };
}

export interface CodexSession {
  id: string;
  timestamp: string;
  cwd: string;
  filePath: string;
  git?: {
    commit_hash: string;
    branch: string;
    repository_url: string;
  };
}

/**
 * Load the session map from the config file
 */
async function loadSessionMap(): Promise<CodexSessionMap> {
  try {
    const content = await readFile(getSessionsFile(), "utf-8");
    return JSON.parse(content);
  } catch {
    // File doesn't exist or is invalid, return empty map
    return {};
  }
}

/**
 * Save the session map to the config file
 */
async function saveSessionMap(sessionMap: CodexSessionMap): Promise<void> {
  try {
    const sessionsFile = getSessionsFile();
    // Ensure the directory exists
    await mkdir(path.dirname(sessionsFile), { recursive: true });
    await writeFile(sessionsFile, JSON.stringify(sessionMap, null, 2));
  } catch (error) {
    console.warn("Failed to save codex session map:", error);
  }
}

/**
 * Store a session ID for a specific working directory
 */
export async function storeSessionForCwd(cwd: string, sessionId: string): Promise<void> {
  const sessionMap = await loadSessionMap();
  sessionMap[cwd] = {
    sessionId,
    lastUsed: new Date().toISOString(),
  };
  await saveSessionMap(sessionMap);
}

/**
 * Parse a codex session file to extract session metadata
 */
async function parseCodexSessionFile(filePath: string): Promise<CodexSession | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    // Find the session_meta line
    for (const line of lines) {
      if (!line.trim()) continue;

      const data = JSON.parse(line);
      if (data.type === "session_meta" && data.payload) {
        const payload = data.payload;
        return {
          id: payload.id,
          timestamp: payload.timestamp || data.timestamp,
          cwd: payload.cwd,
          filePath,
          git: payload.git,
        };
      }
    }

    return null;
  } catch {
    // Ignore files that can't be parsed
    return null;
  }
}

/**
 * Get all codex sessions from the .codex/sessions directory
 */
async function getAllCodexSessions(): Promise<CodexSession[]> {
  const sessions: CodexSession[] = [];
  const codexSessionsDir = getCodexSessionsDir();

  try {
    // Walk through year/month/day structure
    const years = await readdir(codexSessionsDir);

    for (const year of years) {
      const yearPath = path.join(codexSessionsDir, year);
      try {
        const months = await readdir(yearPath);

        for (const month of months) {
          const monthPath = path.join(yearPath, month);
          try {
            const days = await readdir(monthPath);

            for (const day of days) {
              const dayPath = path.join(monthPath, day);
              try {
                const files = await readdir(dayPath);

                for (const file of files) {
                  if (file.endsWith(".jsonl")) {
                    const sessionPath = path.join(dayPath, file);
                    const session = await parseCodexSessionFile(sessionPath);
                    if (session) {
                      sessions.push(session);
                    }
                  }
                }
              } catch {
                // Skip directories we can't read
              }
            }
          } catch {
            // Skip directories we can't read
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }
  } catch {
    // .codex/sessions directory doesn't exist or can't be read
    return [];
  }

  return sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/**
 * Get the most recent session for a specific working directory from actual codex files
 */
async function getMostRecentCodexSessionForCwd(targetCwd: string): Promise<CodexSession | null> {
  const allSessions = await getAllCodexSessions();
  const sessionsForCwd = allSessions.filter((session) => session.cwd === targetCwd);
  return sessionsForCwd[0] || null;
}

/**
 * Get the last session ID for a specific working directory
 * Now checks actual codex session files first, falls back to stored mapping
 */
export async function getSessionForCwd(cwd: string): Promise<string | null> {
  // First try to get the most recent session from actual codex files
  const recentSession = await getMostRecentCodexSessionForCwd(cwd);
  if (recentSession) {
    return recentSession.id;
  }

  // Fall back to stored mapping
  const sessionMap = await loadSessionMap();
  return sessionMap[cwd]?.sessionId || null;
}

/**
 * Extract session ID from codex output
 * Session IDs are UUIDs in the format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 */
export function extractSessionId(output: string): string | null {
  // Look for session ID in various contexts where it might appear
  const sessionIdRegex = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const match = output.match(sessionIdRegex);
  return match ? match[0] : null;
}

/**
 * Extract session ID from codex session file content
 * More reliable method that parses the session metadata
 */
export function extractSessionIdFromSessionMeta(sessionContent: string): string | null {
  try {
    // Parse the first line which should contain session metadata
    const firstLine = sessionContent.split("\n")[0];
    const sessionMeta = JSON.parse(firstLine);

    if (sessionMeta.type === "session_meta" && sessionMeta.payload?.id) {
      return sessionMeta.payload.id;
    }
  } catch {
    // If parsing fails, fall back to regex extraction
  }

  return extractSessionId(sessionContent);
}

/**
 * Get recent sessions for a specific working directory from actual codex files
 */
export async function getRecentSessionsForCwd(
  targetCwd: string,
  limit = 5,
): Promise<CodexSession[]> {
  const allSessions = await getAllCodexSessions();
  const sessionsForCwd = allSessions.filter((session) => session.cwd === targetCwd);
  return sessionsForCwd.slice(0, limit);
}

/**
 * Get all working directories with session counts from actual codex files
 */
export async function getAllWorkingDirectories(): Promise<
  { cwd: string; count: number; lastSession: string }[]
> {
  const allSessions = await getAllCodexSessions();
  const cwdMap = new Map<string, { count: number; lastSession: string }>();

  for (const session of allSessions) {
    const existing = cwdMap.get(session.cwd);
    if (existing) {
      existing.count++;
      if (new Date(session.timestamp) > new Date(existing.lastSession)) {
        existing.lastSession = session.timestamp;
      }
    } else {
      cwdMap.set(session.cwd, {
        count: 1,
        lastSession: session.timestamp,
      });
    }
  }

  return Array.from(cwdMap.entries())
    .map(([cwd, data]) => ({ cwd, ...data }))
    .sort((a, b) => new Date(b.lastSession).getTime() - new Date(a.lastSession).getTime());
}

/**
 * Clean up old sessions (keep only the most recent 10 per directory)
 */
async function cleanupOldSessions(): Promise<void> {
  const sessionMap = await loadSessionMap();

  // Group sessions by directory and keep only the most recent ones
  const cleaned: CodexSessionMap = {};

  // Sort all sessions by lastUsed date (most recent first)
  const sortedEntries = Object.entries(sessionMap).sort(
    ([, a], [, b]) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
  );

  // Keep track of how many sessions we've kept per directory
  const dirCounts: { [dir: string]: number } = {};

  for (const [cwd, session] of sortedEntries) {
    const count = dirCounts[cwd] || 0;
    if (count < 5) {
      // Keep up to 5 sessions per directory
      cleaned[cwd] = session;
      dirCounts[cwd] = count + 1;
    }
  }

  await saveSessionMap(cleaned);
}
