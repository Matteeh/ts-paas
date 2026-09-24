import type { Store } from "./db.js";
import {
  AppExistsError,
  AppNotFoundError,
  AppRunningError,
  HostnameInUseError,
} from "./errors.js";
import {
  validateAppName,
  validateEnv,
  validateHostname,
  validateImage,
  validatePort,
} from "./validate.js";

export interface App {
  name: string;
  image: string;
  port: number;
  hostname: string | null;
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface NewApp {
  name: string;
  image: string;
  port: number;
  hostname?: string | null;
  env?: Record<string, string>;
}

/** `env` replaces the whole environment; `hostname: null` clears it. */
export interface AppChanges {
  image?: string;
  port?: number;
  hostname?: string | null;
  env?: Record<string, string>;
}

interface AppRow {
  name: string;
  image: string;
  port: number;
  hostname: string | null;
  env: string;
  created_at: string;
  updated_at: string;
}

const SELECT_APP =
  "SELECT name, image, port, hostname, env, created_at, updated_at FROM apps";

function rowToApp(row: AppRow): App {
  return {
    name: row.name,
    image: row.image,
    port: row.port,
    hostname: row.hostname,
    env: JSON.parse(row.env) as Record<string, string>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findApp(store: Store, name: string): App | undefined {
  const row = store.db
    .prepare(`${SELECT_APP} WHERE name = ?`)
    .get(name) as AppRow | undefined;
  return row === undefined ? undefined : rowToApp(row);
}

function hostnameOwner(store: Store, hostname: string): string | undefined {
  const row = store.db
    .prepare("SELECT name FROM apps WHERE hostname = ?")
    .get(hostname) as { name: string } | undefined;
  return row?.name;
}

export function createApp(store: Store, input: NewApp): App {
  const name = validateAppName(input.name);
  const image = validateImage(input.image);
  const port = validatePort(input.port);
  const hostname =
    input.hostname === undefined || input.hostname === null
      ? null
      : validateHostname(input.hostname);
  const env = input.env === undefined ? {} : validateEnv(input.env);

  if (findApp(store, name) !== undefined) {
    throw new AppExistsError(name);
  }
  if (hostname !== null) {
    const owner = hostnameOwner(store, hostname);
    if (owner !== undefined) {
      throw new HostnameInUseError(hostname, owner);
    }
  }

  const now = store.clock.now().toISOString();
  store.db
    .prepare(
      "INSERT INTO apps (name, image, port, hostname, env, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(name, image, port, hostname, JSON.stringify(env), now, now);

  return { name, image, port, hostname, env, createdAt: now, updatedAt: now };
}

export function getApp(store: Store, name: string): App {
  const app = findApp(store, name);
  if (app === undefined) {
    throw new AppNotFoundError(name);
  }
  return app;
}

export function listApps(store: Store): App[] {
  const rows = store.db
    .prepare(`${SELECT_APP} ORDER BY name`)
    .all() as unknown as AppRow[];
  return rows.map(rowToApp);
}

export function updateApp(
  store: Store,
  name: string,
  changes: AppChanges,
): App {
  const current = getApp(store, name);

  let image = current.image;
  let port = current.port;
  let hostname = current.hostname;
  let env = current.env;

  if (changes.image !== undefined) {
    image = validateImage(changes.image);
  }
  if (changes.port !== undefined) {
    port = validatePort(changes.port);
  }
  if (changes.env !== undefined) {
    env = validateEnv(changes.env);
  }
  if (changes.hostname !== undefined) {
    hostname =
      changes.hostname === null ? null : validateHostname(changes.hostname);
  }

  if (hostname !== null) {
    const owner = hostnameOwner(store, hostname);
    if (owner !== undefined && owner !== name) {
      throw new HostnameInUseError(hostname, owner);
    }
  }

  const updatedAt = store.clock.now().toISOString();
  store.db
    .prepare(
      "UPDATE apps SET image = ?, port = ?, hostname = ?, env = ?, updated_at = ? WHERE name = ?",
    )
    .run(image, port, hostname, JSON.stringify(env), updatedAt, name);

  return {
    name,
    image,
    port,
    hostname,
    env,
    createdAt: current.createdAt,
    updatedAt,
  };
}

export function deleteApp(store: Store, name: string): void {
  getApp(store, name);

  const running = store.db
    .prepare(
      "SELECT 1 AS one FROM deployments WHERE app = ? AND status = 'running' LIMIT 1",
    )
    .get(name);
  if (running !== undefined) {
    throw new AppRunningError(name);
  }

  store.db.prepare("DELETE FROM apps WHERE name = ?").run(name);
}
