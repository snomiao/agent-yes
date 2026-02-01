import { mkdir } from "fs/promises";
import path from "path";
import { logger } from "./logger";

// Direct SQLite implementation to avoid Kysely compatibility issues
export class SqliteAdapter {
  private db: any;
  private isInitialized = false;

  async init(dbPath: string) {
    try {
      // Ensure parent directory exists
      const dir = path.dirname(dbPath);
      await mkdir(dir, { recursive: true });

      if (typeof globalThis.Bun !== "undefined") {
        // In Bun environment, use bun:sqlite
        const { Database } = await import("bun:sqlite");
        this.db = new Database(dbPath);
      } else {
        // In Node.js environment, use node:sqlite
        const { DatabaseSync } = await import("node:sqlite");
        this.db = new DatabaseSync(dbPath);
      }

      this.isInitialized = true;
      logger.debug(`[SqliteAdapter] Initialized database at ${dbPath}`);
    } catch (error) {
      logger.warn(`[SqliteAdapter] Failed to initialize database at ${dbPath}:`, error);
      // Create a no-op fallback that won't crash
      this.db = this.createFallbackDb();
      this.isInitialized = false;
    }
  }

  private createFallbackDb() {
    // In-memory fallback when SQLite fails
    const storage = new Map<string, any[]>();
    return {
      prepare: (sql: string) => ({
        all: (...params: any[]) => {
          logger.debug("[SqliteAdapter] Using fallback mode (query):", sql);
          return storage.get(sql) || [];
        },
        run: (...params: any[]) => {
          logger.debug("[SqliteAdapter] Using fallback mode (run):", sql);
          return { lastInsertRowid: 0, changes: 0 };
        },
      }),
      query: (sql: string) => ({
        all: (params: any[]) => {
          logger.debug("[SqliteAdapter] Using fallback mode (query):", sql);
          return storage.get(sql) || [];
        },
      }),
      run: (sql: string, params: any[]) => {
        logger.debug("[SqliteAdapter] Using fallback mode (run):", sql);
      },
      close: () => {
        logger.debug("[SqliteAdapter] Closing fallback db");
      },
    };
  }

  query(sql: string, params: any[] = []): any[] {
    try {
      if (typeof this.db.query === "function") {
        // bun:sqlite style
        return this.db.query(sql).all(params);
      } else {
        // node:sqlite style
        return this.db.prepare(sql).all(...params);
      }
    } catch (error) {
      logger.warn("[SqliteAdapter] Query failed:", error);
      return [];
    }
  }

  run(sql: string, params: any[] = []): { lastInsertRowid?: number; changes?: number; } {
    try {
      if (typeof this.db.query === "function") {
        // bun:sqlite style
        this.db.run(sql, params);
        return {}; // Bun doesn't return metadata in the same way
      } else {
        // node:sqlite style
        return this.db.prepare(sql).run(...params);
      }
    } catch (error) {
      logger.warn("[SqliteAdapter] Run failed:", error);
      return {};
    }
  }

  close() {
    try {
      if (this.db?.close) {
        this.db.close();
      }
    } catch (error) {
      logger.warn("[SqliteAdapter] Close failed:", error);
    }
  }

  isReady(): boolean {
    return this.isInitialized;
  }
}
