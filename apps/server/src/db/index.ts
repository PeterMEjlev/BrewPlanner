import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the SQLite file. Override with DATABASE_PATH in production. */
export const databasePath = resolve(
  process.env.DATABASE_PATH ?? resolve(__dirname, '../../data/checklist.sqlite'),
);

// Ensure the parent directory exists before SQLite tries to open the file.
mkdirSync(dirname(databasePath), { recursive: true });

// Exported raw handle for maintenance work that needs pragmas (see
// devices/retention.ts); everything else goes through the drizzle `db`.
export const sqlite: Database.Database = new Database(databasePath);
sqlite.pragma('journal_mode = WAL');
// The standard pairing for WAL: commits stop fsync'ing the log every time and
// sync at checkpoints instead. Still crash-safe — a power cut can lose the last
// transactions but cannot corrupt the database — and it takes a lot of write
// load off the Pi's SD card, which telemetry ingest hits every few seconds.
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

/** Apply any pending migrations. Called once on startup. */
export function runMigrations(): void {
  // ./drizzle sits next to src/dist; resolve relative to this module so it
  // works both from src (tsx) and dist (compiled).
  const fallback = resolve(__dirname, '../../drizzle');
  const candidates = [fallback, resolve(__dirname, '../../../drizzle')];
  const migrationsFolder = candidates.find((p) => existsSync(p)) ?? fallback;
  migrate(db, { migrationsFolder });
}

export { schema };
