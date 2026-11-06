/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * SQLite Database Client (TASK-040 & Development Database Layer)
 * Menggunakan DatabaseSync native dari Node.js 24.
 * Wajib menegakkan foreign keys dan WAL mode untuk transaksi aman.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface DatabaseClient {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
  close(): void;
  transaction<T>(fn: () => T): T;
}

let defaultDbInstance: DatabaseClient | null = null;

export function getDatabasePath(): string {
  const envPath = process.env.DATABASE_PATH;
  if (envPath && envPath.trim()) {
    return path.resolve(/*turbopackIgnore: true*/ process.cwd(), envPath.trim());
  }
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data", "dev.db");
}

export function createDatabaseConnection(customPath?: string): DatabaseClient {
  const dbPath = customPath ?? getDatabasePath();

  // Pastikan folder database ada jika menggunakan file fisik (bukan :memory:)
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const rawDb = new DatabaseSync(dbPath);

  // Penegakan wajib integritas relasional
  rawDb.exec("PRAGMA foreign_keys = ON;");
  if (dbPath !== ":memory:") {
    rawDb.exec("PRAGMA journal_mode = WAL;");
    rawDb.exec("PRAGMA busy_timeout = 5000;");
  }

  let inTransaction = false;

  const client: DatabaseClient = {
    exec(sql: string) {
      rawDb.exec(sql);
    },
    prepare(sql: string) {
      const stmt = rawDb.prepare(sql);
      return {
        all(...params: unknown[]) {
          return stmt.all(...params) as unknown[];
        },
        get(...params: unknown[]) {
          return stmt.get(...params) as unknown;
        },
        run(...params: unknown[]) {
          return stmt.run(...params);
        },
      };
    },
    close() {
      rawDb.close();
    },
    transaction<T>(fn: () => T): T {
      if (inTransaction) {
        return fn();
      }
      inTransaction = true;
      rawDb.exec("BEGIN IMMEDIATE;");
      try {
        const result = fn();
        rawDb.exec("COMMIT;");
        return result;
      } catch (error) {
        rawDb.exec("ROLLBACK;");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };

  return client;
}

/**
 * Mendapatkan koneksi singleton untuk aplikasi development.
 */
export function getDb(): DatabaseClient {
  if (!defaultDbInstance) {
    defaultDbInstance = createDatabaseConnection();
  }
  return defaultDbInstance;
}

export const getDatabaseClient = getDb;

/**
 * Reset koneksi database (terutama untuk test teardown).
 */
export function closeDefaultDb(): void {
  if (defaultDbInstance) {
    try {
      defaultDbInstance.close();
    } catch {
      // Abaikan jika sudah tertutup
    }
    defaultDbInstance = null;
  }
}
