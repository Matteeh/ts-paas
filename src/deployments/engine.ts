import type { ContainerRuntime } from "../runtime/types.js";
import { ContainerNotFoundError } from "../runtime/errors.js";
import { getApp } from "../state/apps.js";
import type { Deployment } from "../state/deployments.js";
import {
  createDeployment,
  deploymentHistory,
  getDeployment,
  setDeploymentStatus,
} from "../state/deployments.js";
import { DeploymentInProgressError } from "./errors.js";
import { checkHealth, healthFailureMessage } from "./health.js";
import type { EngineDeps } from "./types.js";
import {
  APP_LABEL,
  DEFAULT_HEALTH_WINDOW_MS,
  DEFAULT_STOP_TIMEOUT_SECONDS,
  DEPLOYMENT_LABEL,
  IN_PROGRESS_STATUSES,
  PAAS_NETWORK,
  containerName,
} from "./types.js";

/** Tunables for a single `deploy` call. */
export interface DeployOptions {
  healthWindowMs?: number;
  stopTimeoutSeconds?: number;
}

/** The first line of an error, so progress messages stay one line. */
function oneLine(message: string): string {
  const first = message.split("\n", 1)[0];
  return first === undefined || first === "" ? "deployment failed" : first;
}

/** Remove a container we created, ignoring any error. */
async function forceRemove(
  runtime: ContainerRuntime,
  containerId: string,
): Promise<void> {
  try {
    await runtime.removeContainer(containerId, { force: true });
  } catch {
    // A failed cleanup must not hide the original failure.
  }
}

/**
 * Stop and remove a previous deployment's container. Returns `null` when it
 * is gone (including when it was already removed out of band), otherwise the
 * message of the error that left it behind.
 */
async function removePreviousContainer(
  runtime: ContainerRuntime,
  containerId: string,
  options: DeployOptions,
): Promise<string | null> {
  try {
    await runtime.stopContainer(containerId, {
      timeoutSeconds:
        options.stopTimeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS,
    });
  } catch (error) {
    if (error instanceof ContainerNotFoundError) {
      return null;
    }
    return error instanceof Error ? error.message : String(error);
  }

  try {
    await runtime.removeContainer(containerId, { force: true });
  } catch (error) {
    if (error instanceof ContainerNotFoundError) {
      return null;
    }
    return error instanceof Error ? error.message : String(error);
  }

  return null;
}

/**
 * After the new deployment is running, take down every other running
 * deployment of the same app. A failure to remove one still marks it
 * `replaced`, reports the error, and leaves it for reconcile.
 */
async function replacePrevious(
  deps: EngineDeps,
  app: string,
  newDeploymentId: string,
  options: DeployOptions,
): Promise<void> {
  const { store, runtime } = deps;
  const previous = deploymentHistory(store, app).filter(
    (deployment) =>
      deployment.status === "running" && deployment.id !== newDeploymentId,
  );

  for (const deployment of previous) {
    let message = `replaced by deployment ${newDeploymentId}`;
    if (deployment.containerId !== null) {
      const failure = await removePreviousContainer(
        runtime,
        deployment.containerId,
        options,
      );
      if (failure !== null) {
        message = `${message}; could not remove container: ${failure}`;
      }
    }

    setDeploymentStatus(store, deployment.id, "replaced");
    deps.onProgress?.({
      deploymentId: deployment.id,
      status: "replaced",
      message,
    });
  }
}

/**
 * Take an app from its stored image to a running container, recording every
 * status change. Resolves with the final deployment (running or failed) and
 * only rejects when the app is unknown or another deploy is in progress.
 */
export async function deploy(
  deps: EngineDeps,
  app: string,
  options: DeployOptions = {},
): Promise<Deployment> {
  const { store, runtime, clock } = deps;
  const application = getApp(store, app);

  const inProgress = deploymentHistory(store, app).find((deployment) =>
    IN_PROGRESS_STATUSES.includes(deployment.status),
  );
  if (inProgress !== undefined) {
    throw new DeploymentInProgressError(app, inProgress.id);
  }

  const deployment = createDeployment(store, {
    app,
    image: application.image,
  });
  deps.onProgress?.({
    deploymentId: deployment.id,
    status: "pending",
    message: "deployment created",
  });

  let containerId: string | null = null;

  try {
    setDeploymentStatus(store, deployment.id, "pulling");
    deps.onProgress?.({
      deploymentId: deployment.id,
      status: "pulling",
      message: `pulling image ${application.image}`,
    });
    await runtime.pullImage(application.image);

    await runtime.ensureNetwork(PAAS_NETWORK);

    containerId = await runtime.createContainer({
      name: containerName(app, deployment.id),
      image: application.image,
      env: application.env,
      labels: {
        [APP_LABEL]: app,
        [DEPLOYMENT_LABEL]: deployment.id,
      },
      network: PAAS_NETWORK,
      internalPort: application.port,
      restartPolicy: "unless-stopped",
    });

    setDeploymentStatus(store, deployment.id, "starting", { containerId });
    deps.onProgress?.({
      deploymentId: deployment.id,
      status: "starting",
      message: `starting container ${containerName(app, deployment.id)}`,
    });
    await runtime.startContainer(containerId);

    const health = await checkHealth(
      runtime,
      clock,
      containerId,
      options.healthWindowMs ?? DEFAULT_HEALTH_WINDOW_MS,
    );

    if (!health.healthy) {
      await runtime.removeContainer(containerId, { force: true });
      const message = healthFailureMessage(health);
      setDeploymentStatus(store, deployment.id, "failed", { error: message });
      deps.onProgress?.({
        deploymentId: deployment.id,
        status: "failed",
        message: oneLine(message),
      });
      return getDeployment(store, deployment.id);
    }

    setDeploymentStatus(store, deployment.id, "running");
    deps.onProgress?.({
      deploymentId: deployment.id,
      status: "running",
      message: `container ${containerName(app, deployment.id)} is running`,
    });

    await replacePrevious(deps, app, deployment.id, options);
    return getDeployment(store, deployment.id);
  } catch (error) {
    if (containerId !== null) {
      await forceRemove(runtime, containerId);
    }
    const message = error instanceof Error ? error.message : String(error);
    setDeploymentStatus(store, deployment.id, "failed", { error: message });
    deps.onProgress?.({
      deploymentId: deployment.id,
      status: "failed",
      message: oneLine(message),
    });
    return getDeployment(store, deployment.id);
  }
}
