type LogLevel = "error" | "warn" | "info" | "http" | "verbose" | "debug" | "silly";
type WinstonLike = Record<LogLevel, (msg: string, ...meta: unknown[]) => void>;

let _inner: WinstonLike | null = null;
let _initPromise: Promise<void> | null = null;
const _queue: Array<{ level: LogLevel; msg: string; meta: unknown[] }> = [];

function init(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = import("winston").then(({ default: winston }) => {
    const logFormat = winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
        return `${timestamp} [${level}]: ${message}${metaStr}`;
      }),
    );
    _inner = winston.createLogger({
      level: process.env.VERBOSE ? "debug" : "info",
      format: logFormat,
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(winston.format.colorize(), logFormat),
        }),
      ],
      silent: false,
    }) as unknown as WinstonLike;
    for (const { level, msg, meta } of _queue.splice(0)) {
      _inner[level](msg, ...meta);
    }
  });
  return _initPromise;
}

function makeMethod(level: LogLevel) {
  return (msg: string, ...meta: unknown[]) => {
    if (_inner) {
      _inner[level](msg, ...meta);
    } else {
      _queue.push({ level, msg, meta });
      init().catch((e) => console.error("[logger] Failed to load winston:", e));
    }
  };
}

/** Wait for all queued log messages to be flushed. Call before process.exit when needed. */
export async function flushLogger(): Promise<void> {
  await init();
}

/** Add a winston transport. Awaits logger initialization first. */
export async function addTransport(transport: unknown): Promise<void> {
  await init();
  (_inner as unknown as { add(t: unknown): void }).add(transport);
}

export const logger = {
  error: makeMethod("error"),
  warn: makeMethod("warn"),
  info: makeMethod("info"),
  http: makeMethod("http"),
  verbose: makeMethod("verbose"),
  debug: makeMethod("debug"),
  silly: makeMethod("silly"),
};
