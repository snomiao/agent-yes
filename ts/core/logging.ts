import path from "path";
import { mkdir, writeFile } from "fs/promises";
import winston from "winston";
import { logger } from "../logger.ts";
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
  const logDir = pidStore.getLogDir();
  await mkdir(logDir, { recursive: true });
  const rawLogPath = path.resolve(path.dirname(logDir), `${pid}.raw.log`);
  const rawLinesLogPath = path.resolve(path.dirname(logDir), `${pid}.lines.log`);
  const debuggingLogsPath = path.resolve(path.dirname(logDir), `${pid}.debug.log`);

  return {
    logPath: logDir,
    rawLogPath,
    rawLinesLogPath,
    debuggingLogsPath,
  };
}

/**
 * Setup debug logging to file
 * @param debuggingLogsPath Path to debug log file
 */
export function setupDebugLogging(debuggingLogsPath: string | false) {
  if (debuggingLogsPath) {
    logger.add(
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
export async function saveLogFile(logPath: string | false, content: string) {
  if (!logPath) return;

  await mkdir(path.dirname(logPath), { recursive: true }).catch(() => null);
  await writeFile(logPath, content).catch(() => null);
  logger.info(`Full logs saved to ${logPath}`);
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
