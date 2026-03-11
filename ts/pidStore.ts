import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { logger } from "./logger.ts";
import { JsonlStore } from "./JsonlStore.ts";

export interface PidRecord {
  _id?: string;
  pid: number;
  cli: string;
  args: string;
  prompt?: string;
  cwd: string;
  logFile: string;
  fifoFile: string;
  status: "idle" | "active" | "exited";
  exitReason: string;
  exitCode?: number;
  startedAt: number;
}

export class PidStore {
  private storeDir: string;
  private store: JsonlStore<PidRecord>;

  constructor(workingDir: string) {
    this.storeDir = path.resolve(workingDir, ".agent-yes");
    this.store = new JsonlStore<PidRecord>(path.join(this.storeDir, "pid-records.jsonl"));
  }

  async init(): Promise<void> {
    try {
      await this.ensureGitignore();
      await this.store.load();
      await this.cleanStaleRecords();
    } catch (error) {
      logger.warn("[pidStore] Failed to initialize:", error);
    }
  }

  async registerProcess({
    pid,
    cli,
    args,
    prompt,
    cwd,
  }: {
    pid: number;
    cli: string;
    args: string[];
    prompt?: string;
    cwd: string;
  }): Promise<PidRecord> {
    const now = Date.now();
    const argsJson = JSON.stringify(args);
    const logFile = path.resolve(this.getLogDir(), `${pid}.log`);
    const fifoFile = this.getFifoPath(pid);

    const record: Omit<PidRecord, "_id"> = {
      pid,
      cli,
      args: argsJson,
      prompt,
      cwd,
      logFile,
      fifoFile,
      status: "active",
      exitReason: "",
      startedAt: now,
    };

    // Upsert by pid
    const existing = this.store.findOne((doc) => doc.pid === pid);
    if (existing) {
      await this.store.updateById(existing._id!, record);
    } else {
      await this.store.append(record as PidRecord);
    }

    const result = this.store.findOne((doc) => doc.pid === pid);

    if (!result) {
      const allRecords = this.store.getAll();
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
    const existing = this.store.findOne((doc) => doc.pid === pid);
    if (!existing) return;

    const patch: Partial<PidRecord> = { status };
    if (extra?.exitReason !== undefined) patch.exitReason = extra.exitReason;
    if (extra?.exitCode !== undefined) patch.exitCode = extra.exitCode;

    await this.store.updateById(existing._id!, patch);
    logger.debug(`[pidStore] Updated process ${pid} status=${status}`);
  }

  getAllRecords(): PidRecord[] {
    return this.store.getAll();
  }

  getLogDir() {
    return path.resolve(this.storeDir, "logs");
  }

  getFifoPath(pid: number) {
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\agent-yes-${pid}`;
    } else {
      return path.resolve(this.storeDir, "fifo", `${pid}.stdin`);
    }
  }

  async cleanStaleRecords(): Promise<void> {
    const activeRecords = this.store.find((r) => r.status !== "exited");

    for (const record of activeRecords) {
      if (!this.isProcessAlive(record.pid)) {
        await this.store.updateById(record._id!, {
          status: "exited",
          exitReason: "stale-cleanup",
        });
        logger.debug(`[pidStore] Cleaned stale record for PID ${record.pid}`);
      }
    }
  }

  async close(): Promise<void> {
    try {
      await this.store.compact();
    } catch (error) {
      logger.debug("[pidStore] Compact on close failed:", error);
    }
    logger.debug("[pidStore] Database compacted and closed");
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
pid-db/
*.jsonl
*.jsonl~
*.jsonl.lock
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
      await mkdir(this.storeDir, { recursive: true });
      await writeFile(gitignorePath, gitignoreContent, { flag: "wx" });
      logger.debug(`[pidStore] Created .gitignore in ${this.storeDir}`);
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        logger.warn(`[pidStore] Failed to create .gitignore:`, error);
      }
    }
  }

  static async findActiveFifo(workingDir: string): Promise<string | null> {
    try {
      const store = new PidStore(workingDir);
      await store.init();

      const records = store.store
        .find((r) => r.status !== "exited")
        .sort((a, b) => b.startedAt - a.startedAt);

      await store.close();
      return records[0]?.fifoFile ?? null;
    } catch (error) {
      logger.warn("[pidStore] findActiveFifo failed:", error);
      return null;
    }
  }
}
