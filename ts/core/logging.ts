import path from "path";
import { mkdir, writeFile } from "fs/promises";
import { logger, addTransport } from "../logger.ts";
import { PidStore } from "../pidStore.ts";

/**
 * Log path management for agent sessions
 */
export interface LogPaths {
  logPath: string | false;
  rawLogPath: string | false;
  rawLinesLogPath: string | false;
  debuggingLogsPath: string | false;
}

/**
 * Initialize log paths based on PID
 * @param pidStore PID store instance
 * @param pid Process ID
 * @returns Object containing all log paths
 */
export async function initializeLogPaths(pidStore: PidStore, pid: number): Promise<LogPaths> {
  const storeDir = pidStore.getStoreDir();
  await mkdir(storeDir, { recursive: true });

  return {
    // Rendered plain-text log (final). Previously this was the logs/ *directory*,
    // so saveLogFile's writeFile() hit EISDIR and the render was silently lost —
    // which is why raw logs piled up forever (nothing was ever "rendered").
    logPath: pidStore.getRenderedLogPath(pid),
    rawLogPath: pidStore.getRawLogPath(pid),
    rawLinesLogPath: path.resolve(storeDir, `${pid}.lines.log`),
    debuggingLogsPath: path.resolve(storeDir, `${pid}.debug.log`),
  };
}

/**
 * Setup debug logging to file
 * @param debuggingLogsPath Path to debug log file
 */
export async function setupDebugLogging(debuggingLogsPath: string | false): Promise<void> {
  if (debuggingLogsPath) {
    const { default: winston } = await import("winston");
    await addTransport(
      new winston.transports.File({
        filename: debuggingLogsPath,
        level: "debug",
      }),
    );
  }
}

/**
 * Save rendered terminal output to log file
 * @param logPath Path to log file
 * @param content Rendered content to save
 */
export async function saveLogFile(logPath: string | false, content: string): Promise<boolean> {
  if (!logPath) return false;
  if (!content.trim()) return false; // nothing meaningful to persist

  try {
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, content);
    logger.info(`Full logs saved to ${logPath}`);
    return true;
  } catch (error) {
    logger.warn(`Failed to save rendered log to ${logPath}:`, error);
    return false;
  }
}

/**
 * Save logs to deprecated logFile option (for backward compatibility)
 * @param logFile User-specified log file path
 * @param content Rendered content to save
 * @param verbose Whether to log verbose messages
 */
export async function saveDeprecatedLogFile(
  logFile: string | undefined,
  content: string,
  verbose: boolean,
) {
  if (!logFile) return;

  if (verbose) logger.info(`Writing rendered logs to ${logFile}`);
  const logFilePath = path.resolve(logFile);
  await mkdir(path.dirname(logFilePath), { recursive: true }).catch(() => null);
  await writeFile(logFilePath, content);
}
