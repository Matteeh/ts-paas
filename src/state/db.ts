import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import { SchemaTooNewError } from "./errors.js";

/**
 * The whole v1 schema as a single numbered migration. Tasks that add
 * repositories build on this schema and never edit it.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE apps (
    name TEXT PRIMARY KEY,
    image TEXT NOT NULL,
    port INTEGER NOT NULL,
    hostname TEXT UNIQUE,
    env TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE deployments (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    app TEXT NOT NULL REFERENCES apps(name) ON DELETE CASCADE,
    image TEXT NOT NULL,
    status TEXT NOT NULL,
    container_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE deployment_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    at TEXT NOT NULL
  );
  `,
];

export interface Store {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  newId(): string;
  close(): void;
}

export interface OpenStoreOptions {
  /** Defaults to the system clock. */
  clock?: Clock;
  /** Defaults to 12 random lowercase hex characters. */
  newId?: () => string;
  /** Defaults to `MIGRATIONS`; tests may pass their own. */
  migrations?: readonly string[];
}

function defaultNewId(): string {
  return randomBytes(6).toString("hex");
}

function latestVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get();
  const value = row?.version;
  return typeof value === "number" ? value : 0;
}

/**
 * Open (creating when needed) the state database at `path`, applying every
 * unapplied numbered migration in order, each in its own transaction.
 * `":memory:"` opens an in-memory database instead of a file.
 */
export function openStore(
  path: string,
  options: OpenStoreOptions = {},
): Store {
  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? defaultNewId;
  const migrations = options.migrations ?? MIGRATIONS;

  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  const store: Store = { db, clock, newId, close: () => db.close() };

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );

    const current = latestVersion(db);
    if (current > migrations.length) {
      throw new SchemaTooNewError(current, migrations.length);
    }

    for (let i = current; i < migrations.length; i++) {
      const version = i + 1;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(migrations[i]!);
        db.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        ).run(version, clock.now().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Keep the original migration failure.
        }
        throw error;
      }
    }
  } catch (error) {
    db.close();
    throw error;
  }

  return store;
}

/** The highest recorded migration version, or 0 when none were applied. */
export function schemaVersion(store: Store): number {
  return latestVersion(store.db);
}
