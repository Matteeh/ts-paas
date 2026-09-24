import { ContainerNotFoundError } from "../runtime/errors.js";
import { getApp } from "../state/apps.js";
import type { Deployment } from "../state/deployments.js";
import {
  deploymentHistory,
  getDeployment,
  setDeploymentStatus,
} from "../state/deployments.js";
import { AppNotRunningError } from "./errors.js";
import type { EngineDeps } from "./types.js";
import { DEFAULT_STOP_TIMEOUT_SECONDS, containerName } from "./types.js";

/** Tunables for a single `stopApp` call. */
export interface StopOptions {
  stopTimeoutSeconds?: number;
}

/**
 * Stop an app: stop and remove its running deployment's container, then mark
 * the deployment `stopped`. A container that no longer exists counts as
 * removed; any other runtime failure propagates and leaves the deployment
 * running.
 */
export async function stopApp(
  deps: EngineDeps,
  app: string,
  options: StopOptions = {},
): Promise<Deployment> {
  const { store, runtime } = deps;
  getApp(store, app);

  const running = deploymentHistory(store, app).find(
    (deployment) => deployment.status === "running",
  );
  if (running === undefined) {
    throw new AppNotRunningError(app);
  }

  if (running.containerId !== null) {
    const containerId = running.containerId;
    try {
      await runtime.stopContainer(containerId, {
        timeoutSeconds:
          options.stopTimeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS,
      });
    } catch (error) {
      if (!(error instanceof ContainerNotFoundError)) {
        throw error;
      }
    }

    try {
      await runtime.removeContainer(containerId, { force: true });
    } catch (error) {
      if (!(error instanceof ContainerNotFoundError)) {
        throw error;
      }
    }
  }

  setDeploymentStatus(store, running.id, "stopped");
  deps.onProgress?.({
    deploymentId: running.id,
    status: "stopped",
    message: `stopped container ${containerName(app, running.id)}`,
  });
  return getDeployment(store, running.id);
}
