import type { Clock } from "../clock.js";
import type { ContainerInfo, ContainerRuntime } from "../runtime/types.js";
import { HEALTH_LOG_LINES } from "./types.js";

export type HealthResult =
  | { healthy: true }
  | { healthy: false; reason: string; exitCode: number | null; logs: string[] };

function sameTime(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.getTime() === b.getTime();
}

function unhealthyReason(info: ContainerInfo): string {
  if (info.state === "exited") {
    return `container exited with code ${info.exitCode}`;
  }
  return `container is not running (state ${info.state})`;
}

async function lastLogTexts(
  runtime: ContainerRuntime,
  containerId: string,
): Promise<string[]> {
  const entries = await runtime.containerLogs(containerId, {
    tail: HEALTH_LOG_LINES,
  });
  return entries.map((entry) => entry.text);
}

function failure(
  runtime: ContainerRuntime,
  containerId: string,
  info: ContainerInfo,
  reason: string,
): Promise<HealthResult> {
  const exitCode = info.state === "exited" ? info.exitCode : null;
  return lastLogTexts(runtime, containerId).then((logs) => ({
    healthy: false,
    reason,
    exitCode,
    logs,
  }));
}

/**
 * Watch a freshly started container across a window on the injected clock.
 * A container that is not running immediately is unhealthy at once; otherwise
 * it is healthy only when it is still running, has not restarted, and its
 * start time is unchanged at the end of the window.
 */
export async function checkHealth(
  runtime: ContainerRuntime,
  clock: Clock,
  containerId: string,
  windowMs: number,
): Promise<HealthResult> {
  const first = await runtime.inspectContainer(containerId);
  if (first.state !== "running") {
    return failure(runtime, containerId, first, unhealthyReason(first));
  }

  const startedAt = first.startedAt;
  if (windowMs > 0) {
    await clock.sleep(windowMs);
  }
  const second = await runtime.inspectContainer(containerId);

  const restarted =
    second.state === "running" &&
    (second.restartCount !== 0 || !sameTime(second.startedAt, startedAt));

  if (second.state === "running" && !restarted) {
    return { healthy: true };
  }

  const reason = restarted
    ? "container restarted during the health window"
    : unhealthyReason(second);
  return failure(runtime, containerId, second, reason);
}

/** The deployment error for a failed health window: reason then each log line. */
export function healthFailureMessage(result: {
  reason: string;
  logs: readonly string[];
}): string {
  return [result.reason, ...result.logs].join("\n");
}
