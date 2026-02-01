import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { logger } from "./logger.ts";

export interface PidRecord {
  id?: number;
  pid: number;
  cli: string;
  args: string;
  prompt?: string;
  logFile: string;
  fifoFile: string;
  status: "idle" | "active" | "exited";
  exitReason: string;
  exitCode?: number;
  startedAt: number;
  updatedAt: number;
}

// Direct SQLite implementation to avoid Kysely compatibility issues
class SqliteAdapter {
  private db: any;

  async init(dbPath: string) {
    if (typeof globalThis.Bun !== "undefined") {
      try {
        const { Database } = await import("bun:sqlite");
        this.db = new Database(dbPath);
      } catch (error) {
        logger.warn("[pidStore] bun:sqlite not available, falling back to better-sqlite3");
        const Database = (await import("better-sqlite3")).default;
        this.db = new Database(dbPath);
      }
    } else {
      const Database = (await import("better-sqlite3")).default;
      this.db = new Database(dbPath);
    }
  }

  query(sql: string, params: any[] = []): any[] {
    if (typeof this.db.prepare === "function") {
      // better-sqlite3 style
      return this.db.prepare(sql).all(params);
    } else {
      // bun:sqlite style
      return this.db.query(sql).all(params);
    }
  }

  run(sql: string, params: any[] = []): { lastInsertRowid?: number; changes?: number } {
    if (typeof this.db.prepare === "function") {
      // better-sqlite3 style
      return this.db.prepare(sql).run(params);
    } else {
      // bun:sqlite style
      this.db.run(sql, params);
      return {}; // Bun doesn't return metadata in the same way
    }
  }

  close() {
    if (this.db.close) {
      this.db.close();
    }
  }
}

export class PidStore {
  protected db!: SqliteAdapter;
  private storeDir: string;
  private dbPath: string;

  constructor(workingDir: string) {
    this.storeDir = path.resolve(workingDir, ".agent-yes");
    this.dbPath = path.join(this.storeDir, "pid.sqlite");
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.storeDir, "logs"), { recursive: true });
    await mkdir(path.join(this.storeDir, "fifo"), { recursive: true });

    // Auto-generate .gitignore for .agent-yes directory
    await this.ensureGitignore();

    this.db = new SqliteAdapter();
    await this.db.init(this.dbPath);

    // Enable WAL mode for better concurrency and performance
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA synchronous=NORMAL");
    this.db.run("PRAGMA cache_size=1000");
    this.db.run("PRAGMA temp_store=memory");

    // Create table if it doesn't exist
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pid_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pid INTEGER NOT NULL UNIQUE,
        cli TEXT NOT NULL,
        args TEXT NOT NULL,
        prompt TEXT,
        logFile TEXT NOT NULL,
        fifoFile TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        exitReason TEXT NOT NULL DEFAULT '',
        exitCode INTEGER,
        startedAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    await this.cleanStaleRecords();
  }

  async registerProcess({
    pid,
    cli,
    args,
    prompt,
  }: {
    pid: number;
    cli: string;
    args: string[];
    prompt?: string;
  }): Promise<PidRecord> {
    const now = Date.now();
    const argsJson = JSON.stringify(args);
    const logFile = this.getLogPath(pid);
    const fifoFile = this.getFifoPath(pid);

    try {
      this.db.run(`
        INSERT INTO pid_records (pid, cli, args, prompt, logFile, fifoFile, status, exitReason, startedAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, 'active', '', ?, ?)
      `, [pid, cli, argsJson, prompt, logFile, fifoFile, now, now]);
    } catch (error: any) {
      // Handle unique constraint violation by updating existing record
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        this.db.run(`
          UPDATE pid_records
          SET cli = ?, args = ?, prompt = ?, logFile = ?, fifoFile = ?, status = 'active', exitReason = '', startedAt = ?, updatedAt = ?
          WHERE pid = ?
        `, [cli, argsJson, prompt, logFile, fifoFile, now, now, pid]);
      } else {
        throw error;
      }
    }

    // Fetch the record
    const result = this.db.query("SELECT * FROM pid_records WHERE pid = ?", [pid])[0];

    if (!result) {
      // Log all records for debugging
      const allRecords = this.db.query("SELECT * FROM pid_records");
      logger.error(`[pidStore] Failed to find record for PID ${pid}. All records:`, allRecords);
      throw new Error(`Failed to register process ${pid}`);
    }

    logger.debug(`[pidStore] Registered process ${pid}`);
    return result;
  }

  async updateStatus(
    pid: number,
    status: PidRecord["status"],
    extra?: { exitReason?: string; exitCode?: number },
  ): Promise<void> {
    const updatedAt = Date.now();
    const exitReason = extra?.exitReason || "";
    const exitCode = extra?.exitCode;

    if (exitCode !== undefined) {
      this.db.run(
        "UPDATE pid_records SET status = ?, exitReason = ?, exitCode = ?, updatedAt = ? WHERE pid = ?",
        [status, exitReason, exitCode, updatedAt, pid]
      );
    } else {
      this.db.run(
        "UPDATE pid_records SET status = ?, exitReason = ?, updatedAt = ? WHERE pid = ?",
        [status, exitReason, updatedAt, pid]
      );
    }

    logger.debug(`[pidStore] Updated process ${pid} status=${status}`);
  }

  getLogPath(pid: number): string {
    return path.resolve(this.storeDir, "logs", `${pid}.log`);
  }

  getFifoPath(pid: number): string {
    if (process.platform === "win32") {
      // Windows named pipe format
      return `\\\\.\\pipe\\agent-yes-${pid}`;
    } else {
      // Linux FIFO file path
      return path.resolve(this.storeDir, "fifo", `${pid}.stdin`);
    }
  }

  async cleanStaleRecords(): Promise<void> {
    const activeRecords = this.db.query("SELECT * FROM pid_records WHERE status != 'exited'");

    for (const record of activeRecords) {
      if (!this.isProcessAlive(record.pid)) {
        this.db.run(
          "UPDATE pid_records SET status = 'exited', exitReason = 'stale-cleanup', updatedAt = ? WHERE pid = ?",
          [Date.now(), record.pid]
        );

        logger.debug(`[pidStore] Cleaned stale record for PID ${record.pid}`);
      }
    }
  }

  async close(): Promise<void> {
    // Optimize the database (equivalent to compacting in nedb)
    try {
      this.db.run("PRAGMA optimize");
      this.db.run("VACUUM");
    } catch (error) {
      logger.warn("[pidStore] Failed to optimize database:", error);
    }

    this.db.close();
    logger.debug("[pidStore] Database optimized and closed");
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureGitignore(): Promise<void> {
    const gitignorePath = path.join(this.storeDir, ".gitignore");
    const gitignoreContent = `# Auto-generated .gitignore for agent-yes
# Ignore all log files and runtime data
logs/
fifo/
*.sqlite
*.sqlite-*
*.log
*.raw.log
*.lines.log
*.debug.log

# Ignore .gitignore itself
.gitignore

`;

    try {
      await writeFile(gitignorePath, gitignoreContent, { flag: 'wx' }); // wx = create only if doesn't exist
      logger.debug(`[pidStore] Created .gitignore in ${this.storeDir}`);
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        logger.warn(`[pidStore] Failed to create .gitignore:`, error);
      }
      // If file exists, that's fine - don't overwrite existing gitignore
    }
  }

  static async findActiveFifo(workingDir: string): Promise<string | null> {
    const store = new PidStore(workingDir);
    await store.init();

    const records = store.db.query(
      "SELECT * FROM pid_records WHERE status != 'exited' ORDER BY startedAt DESC LIMIT 1"
    );

    await store.close();
    return records[0]?.fifoFile ?? null;
  }
}