import { getApp } from "./apps.js";
import type { Store } from "./db.js";
import {
  DeploymentFinishedError,
  DeploymentNotFoundError,
} from "./errors.js";
import { validateImage } from "./validate.js";

export const DEPLOYMENT_STATUSES = [
  "pending",
  "pulling",
  "starting",
  "running",
  "failed",
  "stopped",
  "replaced",
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** Statuses that end a deployment's life: no further change is allowed. */
export const FINAL_STATUSES: readonly DeploymentStatus[] = [
  "failed",
  "stopped",
  "replaced",
];

export interface Deployment {
  id: string;
  app: string;
  image: string;
  status: DeploymentStatus;
  containerId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface StatusChange {
  status: DeploymentStatus;
  at: string;
}

interface DeploymentRow {
  id: string;
  app: string;
  image: string;
  status: DeploymentStatus;
  container_id: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

const SELECT_DEPLOYMENT =
  "SELECT id, app, image, status, container_id, error, created_at, finished_at FROM deployments";

function rowToDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    app: row.app,
    image: row.image,
    status: row.status,
    containerId: row.container_id,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function findDeployment(store: Store, id: string): Deployment | undefined {
  const row = store.db
    .prepare(`${SELECT_DEPLOYMENT} WHERE id = ?`)
    .get(id) as DeploymentRow | undefined;
  return row === undefined ? undefined : rowToDeployment(row);
}

function recordEvent(
  store: Store,
  deploymentId: string,
  status: DeploymentStatus,
  at: string,
): void {
  store.db
    .prepare(
      "INSERT INTO deployment_events (deployment_id, status, at) VALUES (?, ?, ?)",
    )
    .run(deploymentId, status, at);
}

export function createDeployment(
  store: Store,
  input: { app: string; image: string },
): Deployment {
  getApp(store, input.app);
  const image = validateImage(input.image);

  const id = store.newId();
  const now = store.clock.now().toISOString();

  store.db
    .prepare(
      "INSERT INTO deployments (id, app, image, status, container_id, error, created_at, finished_at) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL)",
    )
    .run(id, input.app, image, now);
  recordEvent(store, id, "pending", now);

  return {
    id,
    app: input.app,
    image,
    status: "pending",
    containerId: null,
    error: null,
    createdAt: now,
    finishedAt: null,
  };
}

export function getDeployment(store: Store, id: string): Deployment {
  const deployment = findDeployment(store, id);
  if (deployment === undefined) {
    throw new DeploymentNotFoundError(id);
  }
  return deployment;
}

export function setDeploymentStatus(
  store: Store,
  id: string,
  status: DeploymentStatus,
  details: { containerId?: string; error?: string } = {},
): Deployment {
  const current = getDeployment(store, id);
  if (FINAL_STATUSES.includes(current.status)) {
    throw new DeploymentFinishedError(id, current.status);
  }

  const containerId = details.containerId ?? current.containerId;
  const error = details.error ?? current.error;
  const now = store.clock.now().toISOString();
  const finishedAt = FINAL_STATUSES.includes(status) ? now : current.finishedAt;

  store.db
    .prepare(
      "UPDATE deployments SET status = ?, container_id = ?, error = ?, finished_at = ? WHERE id = ?",
    )
    .run(status, containerId, error, finishedAt, id);
  recordEvent(store, id, status, now);

  return { ...current, status, containerId, error, finishedAt };
}

export function latestDeployment(store: Store, app: string): Deployment | null {
  getApp(store, app);
  const row = store.db
    .prepare(`${SELECT_DEPLOYMENT} WHERE app = ? ORDER BY seq DESC LIMIT 1`)
    .get(app) as DeploymentRow | undefined;
  return row === undefined ? null : rowToDeployment(row);
}

export function deploymentHistory(
  store: Store,
  app: string,
  options: { limit?: number } = {},
): Deployment[] {
  getApp(store, app);
  const limit = options.limit;
  const rows = (
    limit === undefined
      ? store.db
          .prepare(`${SELECT_DEPLOYMENT} WHERE app = ? ORDER BY seq DESC`)
          .all(app)
      : store.db
          .prepare(
            `${SELECT_DEPLOYMENT} WHERE app = ? ORDER BY seq DESC LIMIT ?`,
          )
          .all(app, limit)
  ) as unknown as DeploymentRow[];
  return rows.map(rowToDeployment);
}

export function deploymentStatusChanges(
  store: Store,
  id: string,
): StatusChange[] {
  getDeployment(store, id);
  const rows = store.db
    .prepare(
      "SELECT status, at FROM deployment_events WHERE deployment_id = ? ORDER BY seq ASC",
    )
    .all(id) as unknown as StatusChange[];
  return rows.map((row) => ({ status: row.status, at: row.at }));
}
