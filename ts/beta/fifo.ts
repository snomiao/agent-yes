import { execaCommand, execaCommandSync } from "execa";
import { fromReadable } from "from-node-stream";
import { createReadStream, mkdirSync } from "fs";
import { unlink } from "fs/promises";
import { dirname } from "path";
import sflow from "sflow";
import { logger } from "../logger.ts";
import { createServer } from "net";

/**
 * Creates an IPC stream (FIFO on Linux, Named Pipes on Windows) for additional stdin input
 * @param cli - The CLI name for logging purposes
 * @param customPath - Optional custom path for the IPC file; if provided, uses this instead of generating a path
 * @returns An object with stream and cleanup function, or null if failed
 */
export function createFifoStream(
  cli: string,
  customPath?: string,
): { stream: ReadableStream<string>; cleanup: () => Promise<void> } | null {
  if (process.platform === "win32") {
    return createWindowsNamedPipe(cli, customPath);
  } else if (process.platform === "linux") {
    return createLinuxFifo(cli, customPath);
  } else {
    logger.warn(`[${cli}-yes] IPC not supported on platform: ${process.platform}`);
    return null;
  }
}

/**
 * Creates a Windows named pipe for IPC
 */
function createWindowsNamedPipe(
  cli: string,
  customPath?: string,
): { stream: ReadableStream<string>; cleanup: () => Promise<void> } | null {
  try {
    // Use customPath directly if provided (should already be in Windows pipe format)
    // Otherwise generate a new pipe path
    let pipePath: string;
    if (customPath) {
      pipePath = customPath;
    } else {
      const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
      const randomSuffix = Math.random().toString(36).substring(2, 5);
      pipePath = `\\\\.\\pipe\\agent-yes-${timestamp}${randomSuffix}`;
    }

    logger.info(`[${cli}-yes] Creating Windows named pipe at ${pipePath}`);

    const server = createServer();
    let connection: any = null;
    let isClosing = false;

    // Create a ReadableStream that handles data from the named pipe
    const stream = new ReadableStream<string>({
      start(controller) {
        server.on('connection', (socket) => {
          connection = socket;
          logger.info(`[${cli}-yes] Client connected to named pipe`);

          socket.on('data', (chunk) => {
            const data = chunk.toString();
            logger.debug(`[${cli}-yes] Received data via named pipe: ${data}`);
            controller.enqueue(data);
          });

          socket.on('end', () => {
            logger.debug(`[${cli}-yes] Client disconnected from named pipe`);
            connection = null;
          });

          socket.on('error', (error) => {
            logger.warn(`[${cli}-yes] Named pipe socket error:`, error);
            if (!isClosing) {
              controller.error(error);
            }
          });
        });

        server.on('error', (error) => {
          logger.warn(`[${cli}-yes] Named pipe server error:`, error);
          if (!isClosing) {
            controller.error(error);
          }
        });

        server.listen(pipePath, () => {
          logger.info(`[${cli}-yes] Named pipe server listening at ${pipePath}`);
        });
      },

      cancel() {
        isClosing = true;
        if (connection) {
          connection.end();
        }
        server.close();
      }
    });

    const cleanup = async () => {
      isClosing = true;
      if (connection) {
        connection.end();
      }
      server.close();
      logger.info(`[${cli}-yes] Cleaned up Windows named pipe at ${pipePath}`);
    };

    // Cleanup on process exit
    process.on("exit", () => cleanup().catch(() => null));
    process.on("SIGINT", () => cleanup().catch(() => null));
    process.on("SIGTERM", () => cleanup().catch(() => null));

    return {
      stream: stream,
      cleanup
    };
  } catch (error) {
    logger.warn(`[${cli}-yes] Failed to create Windows named pipe:`, error);
    return null;
  }
}

/**
 * Creates a Linux FIFO for IPC (original implementation)
 */
function createLinuxFifo(
  cli: string,
  customPath?: string,
): { stream: ReadableStream<string>; cleanup: () => Promise<void> } | null {
  let fifoPath: string | null = null;
  let fifoStream: ReturnType<typeof createReadStream> | null = null;

  logger.debug(`[${cli}-yes] Creating Linux FIFO with customPath: ${customPath}`);

  try {
    if (customPath) {
      fifoPath = customPath;
    } else {
      const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
      const randomSuffix = Math.random().toString(36).substring(2, 5);
      fifoPath = `/tmp/agent-yes-${timestamp}${randomSuffix}.stdin`;
    }

    // Ensure the directory exists
    try {
      mkdirSync(dirname(fifoPath), { recursive: true });
    } catch (dirError) {
      logger.warn(`[${cli}-yes] Failed to create FIFO directory: ${dirError}`);
      return null;
    }

    // Create the named pipe using mkfifo with proper shell escaping
    const escapedPath = fifoPath.replace(/'/g, "'\"'\"'");
    const mkfifoResult = execaCommandSync(`mkfifo '${escapedPath}'`, {
      reject: false,
    });

    if (mkfifoResult.exitCode !== 0) {
      logger.warn(`[${cli}-yes] mkfifo command failed with exit code ${mkfifoResult.exitCode}`);
      logger.warn(`[${cli}-yes] Command: mkfifo '${escapedPath}'`);
      if (mkfifoResult.stderr) {
        logger.warn(`[${cli}-yes] mkfifo stderr: ${mkfifoResult.stderr}`);
      }
      if (mkfifoResult.stdout) {
        logger.warn(`[${cli}-yes] mkfifo stdout: ${mkfifoResult.stdout}`);
      }
      return null;
    }

    logger.info(`[${cli}-yes] Created FIFO at ${fifoPath}`);

    // Open the FIFO for reading
    // Note: This will block until a writer opens the FIFO, so we use a dummy writer to unblock it
    try {
      // Open a dummy writer in background to prevent blocking
      execaCommand(`exec 3>"${fifoPath}"`).catch(() => null);

      fifoStream = createReadStream(fifoPath, {
        flags: "r",
        autoClose: true,
      });

      logger.info(`[${cli}-yes] FIFO opened for reading`);

      // Cleanup FIFO function
      const cleanupFifo = async () => {
        if (fifoStream) {
          try {
            fifoStream.close();
            logger.debug(`[${cli}-yes] Closed FIFO stream`);
          } catch (error) {
            logger.debug(`[${cli}-yes] Error closing FIFO stream:`, { error });
          }
        }
        if (fifoPath) {
          try {
            await unlink(fifoPath).catch(() => null);
            logger.info(`[${cli}-yes] Cleaned up FIFO at ${fifoPath}`);
          } catch {}
        }
      };

      process.on("exit", () => {
        if (fifoPath) unlink(fifoPath).catch(() => null);
      });
      process.on("SIGINT", async () => {
        await cleanupFifo();
      });
      process.on("SIGTERM", async () => {
        await cleanupFifo();
      });

      return {
        stream: sflow(fromReadable(fifoStream)).map((buffer) => buffer.toString()),
        cleanup: cleanupFifo,
      };
    } catch (error) {
      logger.warn(`[${cli}-yes] Failed to open FIFO at ${fifoPath}:`, {
        error,
      });
      if (error instanceof Error) {
        logger.warn(`[${cli}-yes] Error details: ${error.message}`);
        if (error.stack) {
          logger.debug(`[${cli}-yes] Stack trace: ${error.stack}`);
        }
      }
      // Clean up the FIFO if we failed to open it
      if (fifoPath) {
        unlink(fifoPath).catch(() => null);
      }
      return null;
    }
  } catch (error) {
    logger.warn(`[${cli}-yes] Failed to create FIFO:`, { error });
    if (error instanceof Error) {
      logger.warn(`[${cli}-yes] Error details: ${error.message}`);
    }
    if (fifoPath) {
      unlink(fifoPath).catch(() => null);
    }
    return null;
  }
}
