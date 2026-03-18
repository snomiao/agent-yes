import { appendFile, mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { fsyncSync, openSync, closeSync } from "fs";
import path from "path";
import { lock, unlock } from "proper-lockfile";
import { logger } from "./logger.ts";

export interface JsonlDoc {
  _id: string;
  $$deleted?: true;
  [key: string]: any;
}

/**
 * A lightweight NeDB-style JSONL persistence layer.
 *
 * - Append-only writes (one JSON object per line)
 * - Same `_id` → last line wins (fields merged)
 * - `$$deleted` lines act as tombstones
 * - Crash recovery: skip partial last line, recover from temp file
 * - Multi-process safe via proper-lockfile (reads don't need lock)
 * - Compact on close: deduplicates into clean file via atomic rename
 */
export class JsonlStore<T extends Record<string, any> = Record<string, any>> {
  private filePath: string;
  private tempPath: string;
  private lockPath: string;
  private docs = new Map<string, T & JsonlDoc>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.tempPath = filePath + "~";
    // Lock on the directory (proper-lockfile needs an existing path)
    this.lockPath = path.dirname(filePath);
  }

  /**
   * Load all records from the JSONL file. No lock needed.
   * Handles crash recovery: partial last line skipped, temp file recovery.
   */
  async load(): Promise<Map<string, T & JsonlDoc>> {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    // Crash recovery: if temp file exists but main doesn't, recover it
    if (!existsSync(this.filePath) && existsSync(this.tempPath)) {
      logger.debug("[JsonlStore] Recovering from temp file");
      await rename(this.tempPath, this.filePath);
    }

    this.docs = new Map();
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") {
        // File doesn't exist yet — empty store
        return this.docs;
      }
      throw err;
    }

    const lines = raw.split("\n");
    let corruptCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const doc = JSON.parse(trimmed) as T & JsonlDoc;
        if (!doc._id) continue;
        if (doc.$$deleted) {
          this.docs.delete(doc._id);
        } else {
          // Merge: last line per _id wins, fields merged
          const existing = this.docs.get(doc._id);
          if (existing) {
            this.docs.set(doc._id, { ...existing, ...doc });
          } else {
            this.docs.set(doc._id, doc);
          }
        }
      } catch {
        corruptCount++;
        // Skip corrupt/partial lines (crash recovery)
      }
    }

    if (corruptCount > 0) {
      logger.debug(`[JsonlStore] Skipped ${corruptCount} corrupt line(s) in ${this.filePath}`);
    }

    return this.docs;
  }

  /** Get all live documents. */
  getAll(): (T & JsonlDoc)[] {
    return Array.from(this.docs.values());
  }

  /** Find a document by _id. */
  getById(id: string): (T & JsonlDoc) | undefined {
    return this.docs.get(id);
  }

  /** Find documents matching a predicate. */
  find(predicate: (doc: T & JsonlDoc) => boolean): (T & JsonlDoc)[] {
    return this.getAll().filter(predicate);
  }

  /** Find first document matching a predicate. */
  findOne(predicate: (doc: T & JsonlDoc) => boolean): (T & JsonlDoc) | undefined {
    for (const doc of this.docs.values()) {
      if (predicate(doc)) return doc;
    }
    return undefined;
  }

  /**
   * Append a new document. Acquires lock.
   * If no _id is provided, one is generated.
   */
  async append(doc: T & Partial<JsonlDoc>): Promise<T & JsonlDoc> {
    const id = doc._id || generateId();
    const { _id: _, ...rest } = doc;
    const fullDoc = { _id: id, ...rest } as T & JsonlDoc;
    return await this.withLock(async () => {
      await appendFile(this.filePath, JSON.stringify(fullDoc) + "\n");
      // Update in-memory
      const existing = this.docs.get(fullDoc._id);
      if (existing) {
        this.docs.set(fullDoc._id, { ...existing, ...fullDoc });
      } else {
        this.docs.set(fullDoc._id, fullDoc);
      }
      return fullDoc;
    });
  }

  /**
   * Update a document by _id. Appends a merge line. Acquires lock.
   */
  async updateById(id: string, patch: Partial<T>): Promise<void> {
    await this.withLock(async () => {
      const line = { _id: id, ...patch } as JsonlDoc;
      await appendFile(this.filePath, JSON.stringify(line) + "\n");
      // Update in-memory
      const existing = this.docs.get(id);
      if (existing) {
        this.docs.set(id, { ...existing, ...patch } as T & JsonlDoc);
      }
    });
  }

  /**
   * Delete a document by _id. Appends a tombstone. Acquires lock.
   */
  async deleteById(id: string): Promise<void> {
    await this.withLock(async () => {
      const tombstone: JsonlDoc = { _id: id, $$deleted: true };
      await appendFile(this.filePath, JSON.stringify(tombstone) + "\n");
      this.docs.delete(id);
    });
  }

  /**
   * Compact the file: deduplicate entries, remove tombstones.
   * Writes to temp file, fsyncs, then atomic renames.
   * Acquires lock.
   */
  async compact(): Promise<void> {
    await this.withLock(async () => {
      const lines = Array.from(this.docs.values())
        .map((doc) => {
          const { _id, $$deleted, ...rest } = doc;
          return JSON.stringify({ _id, ...rest });
        })
        .join("\n");
      const content = lines ? lines + "\n" : "";

      // Write to temp file
      await writeFile(this.tempPath, content);
      // fsync temp file
      const fd = openSync(this.tempPath, "r");
      fsyncSync(fd);
      closeSync(fd);
      // Atomic rename (on Windows, rename may fail if target exists — unlink first)
      if (process.platform === "win32") {
        try {
          await unlink(this.filePath);
        } catch {}
      }
      await rename(this.tempPath, this.filePath);
    });
  }

  private async withLock<R>(fn: () => Promise<R>): Promise<R> {
    const dir = path.dirname(this.filePath);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock(dir, {
        lockfilePath: this.filePath + ".lock",
        retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
      });
      return await fn();
    } finally {
      if (release) await release();
    }
  }
}

let idCounter = 0;
function generateId(): string {
  return (
    Date.now().toString(36) + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 6)
  );
}
