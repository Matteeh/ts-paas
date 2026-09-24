import { ContainerNotFoundError } from "../runtime/errors.js";
import { MANAGED_LABEL } from "../runtime/types.js";
import type { ContainerSummary } from "../runtime/types.js";
import { listApps } from "../state/apps.js";
import {
  deploymentHistory,
  deploymentStatusChanges,
  setDeploymentStatus,
} from "../state/deployments.js";
import type { Deployment } from "../state/deployments.js";
import { APP_LABEL, IN_PROGRESS_STATUSES } from "./types.js";
import type { EngineDeps } from "./types.js";

/** A deployment in flight longer than this is stuck. */
export const DEFAULT_STUCK_AFTER_MS = 600_000;

export type ReconcileItem =
  | {
      kind: "fail";
      app: string;
      deploymentId: string;
      containerId: string | null;
      error: string;
    }
  | { kind: "orphan"; app: string; containerId: string; name: string };

type FailItem = Extract<ReconcileItem, { kind: "fail" }>;
type OrphanItem = Extract<ReconcileItem, { kind: "orphan" }>;

export interface ReconcileOutcome {
  item: ReconcileItem;
  result: "done" | "failed" | "reported";
  error: string | null;
}

/** Why a running deployment cannot keep running, or `null` when it can. */
async function runningDeploymentError(
  deps: EngineDeps,
  containers: Map<string, ContainerSummary>,
  deployment: Deployment,
): Promise<string | null> {
  const containerId = deployment.containerId;
  if (containerId === null) {
    return "container disappeared";
  }
  const container = containers.get(containerId);
  if (container === undefined) {
    return "container disappeared";
  }
  if (container.state === "running") {
    return null;
  }

  let exitCode: number | null;
  try {
    exitCode = (await deps.runtime.inspectContainer(containerId)).exitCode;
  } catch (error) {
    if (error instanceof ContainerNotFoundError) {
      return "container disappeared";
    }
    throw error;
  }
  if (exitCode !== null) {
    return `container exited with code ${exitCode}`;
  }
  return "container is not running";
}

/** The time of the latest status change when a deployment is stuck. */
function stuckSince(
  deps: EngineDeps,
  deployment: Deployment,
  stuckAfterMs: number,
): string | null {
  const changes = deploymentStatusChanges(deps.store, deployment.id);
  const latest = changes[changes.length - 1];
  if (latest === undefined) {
    return null;
  }
  if (deps.clock.now().getTime() - new Date(latest.at).getTime() > stuckAfterMs) {
    return latest.at;
  }
  return null;
}

/**
 * Compare stored deployments with the managed containers the engine reports.
 * Returns the failures to apply and the orphaned containers, ordered by app
 * name and then container name. Never changes the store or the engine.
 */
export async function planReconcile(
  deps: EngineDeps,
  options: { stuckAfterMs?: number } = {},
): Promise<ReconcileItem[]> {
  const stuckAfterMs = options.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const containers = await deps.runtime.listContainers({
    [MANAGED_LABEL]: "true",
  });
  const byId = new Map(containers.map((container) => [container.id, container]));

  const failures: FailItem[] = [];
  const staying = new Set<string>();
  const owned = new Set<string>();

  for (const app of listApps(deps.store)) {
    for (const deployment of deploymentHistory(deps.store, app.name)) {
      if (deployment.status === "running") {
        const error = await runningDeploymentError(deps, byId, deployment);
        if (error === null) {
          staying.add(deployment.id);
        } else {
          failures.push({
            kind: "fail",
            app: app.name,
            deploymentId: deployment.id,
            containerId: deployment.containerId,
            error,
          });
        }
      } else if (IN_PROGRESS_STATUSES.includes(deployment.status)) {
        const at = stuckSince(deps, deployment, stuckAfterMs);
        if (at === null) {
          staying.add(deployment.id);
        } else {
          failures.push({
            kind: "fail",
            app: app.name,
            deploymentId: deployment.id,
            containerId: deployment.containerId,
            error: `stuck in ${deployment.status} since ${at}`,
          });
        }
      }

      if (staying.has(deployment.id) && deployment.containerId !== null) {
        owned.add(deployment.containerId);
      }
    }
  }

  failures.sort((a, b) => a.app.localeCompare(b.app));

  const orphans: OrphanItem[] = [];
  for (const container of containers) {
    const app = container.labels[APP_LABEL];
    if (app === undefined || owned.has(container.id)) {
      continue;
    }
    orphans.push({
      kind: "orphan",
      app,
      containerId: container.id,
      name: container.name,
    });
  }
  orphans.sort((a, b) => a.name.localeCompare(b.name));

  return [...failures, ...orphans];
}

/**
 * Apply a reconcile plan: mark each failure `failed`, and with `prune`
 * force-remove each orphan. Returns one outcome per item; a failed removal
 * does not stop the rest.
 */
export async function applyReconcile(
  deps: EngineDeps,
  plan: readonly ReconcileItem[],
  options: { prune: boolean },
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];

  for (const item of plan) {
    if (item.kind === "fail") {
      try {
        setDeploymentStatus(deps.store, item.deploymentId, "failed", {
          error: item.error,
        });
        outcomes.push({ item, result: "done", error: null });
      } catch (error) {
        outcomes.push({
          item,
          result: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    if (!options.prune) {
      outcomes.push({ item, result: "reported", error: null });
      continue;
    }

    try {
      await deps.runtime.removeContainer(item.containerId, { force: true });
      outcomes.push({ item, result: "done", error: null });
    } catch (error) {
      if (error instanceof ContainerNotFoundError) {
        outcomes.push({ item, result: "done", error: null });
      } else {
        outcomes.push({
          item,
          result: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return outcomes;
}
