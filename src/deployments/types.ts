import type { Clock } from "../clock.js";
import type { ContainerRuntime } from "../runtime/types.js";
import type { Store } from "../state/db.js";
import type { DeploymentStatus } from "../state/deployments.js";

/** Name of the network every app container joins. */
export const PAAS_NETWORK = "paas-net";
/** Label carrying the app name. */
export const APP_LABEL = "paas.app";
/** Label carrying the deployment id. */
export const DEPLOYMENT_LABEL = "paas.deployment";
/** Default time a new container must stay healthy, in milliseconds. */
export const DEFAULT_HEALTH_WINDOW_MS = 3000;
/** Default timeout for stopping a container, in seconds. */
export const DEFAULT_STOP_TIMEOUT_SECONDS = 10;
/** How many log lines a failed health check keeps. */
export const HEALTH_LOG_LINES = 20;

/** Statuses that mean a deploy is still in flight. */
export const IN_PROGRESS_STATUSES: readonly DeploymentStatus[] = [
  "pending",
  "pulling",
  "starting",
];

/** A single status change reported to the progress callback. */
export interface DeployEvent {
  deploymentId: string;
  status: DeploymentStatus;
  message: string;
}

/** Everything the deployment engine needs, injected. */
export interface EngineDeps {
  store: Store;
  runtime: ContainerRuntime;
  clock: Clock;
  onProgress?: (event: DeployEvent) => void;
}

/** The container name for a deployment: `<app>-<deployment id>`. */
export function containerName(app: string, deploymentId: string): string {
  return `${app}-${deploymentId}`;
}
