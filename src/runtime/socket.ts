import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { RuntimeUnavailableError } from "./errors.js";

/** The filesystem facts socket resolution needs; tests inject their own. */
export interface SocketProbe {
  exists(path: string): boolean;
  homedir: string;
  uid: number;
}

export type SocketSource =
  | "PAAS_SOCKET"
  | "DOCKER_HOST"
  | "PODMAN_SOCKET"
  | "default";

export interface ResolvedSocket {
  path: string;
  source: SocketSource;
}

/** The real probe: `fs.existsSync`, `os.homedir()` and the process uid. */
export const nodeSocketProbe: SocketProbe = {
  exists: (path) => existsSync(path),
  homedir: homedir(),
  uid: process.getuid?.() ?? 0,
};

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

function podmanSocket(env: NodeJS.ProcessEnv, probe: SocketProbe): string {
  const runtimeDir = nonEmpty(env.XDG_RUNTIME_DIR);
  if (runtimeDir !== undefined) {
    return join(runtimeDir, "podman", "podman.sock");
  }
  return join("/run/user", String(probe.uid), "podman", "podman.sock");
}

function explicitSocket(
  env: NodeJS.ProcessEnv,
): { path: string; source: SocketSource } | undefined {
  const paas = nonEmpty(env.PAAS_SOCKET);
  if (paas !== undefined) {
    return { path: paas, source: "PAAS_SOCKET" };
  }
  const dockerHost = nonEmpty(env.DOCKER_HOST);
  if (dockerHost !== undefined && dockerHost.startsWith("unix://")) {
    return {
      path: dockerHost.slice("unix://".length),
      source: "DOCKER_HOST",
    };
  }
  const podman = nonEmpty(env.PODMAN_SOCKET);
  if (podman !== undefined) {
    return { path: podman, source: "PODMAN_SOCKET" };
  }
  return undefined;
}

/**
 * Resolve the engine socket. Explicit settings win and are final; only the
 * default paths are probed. Throws `RuntimeUnavailableError` when a chosen
 * socket is missing or no socket can be found.
 */
export function resolveSocket(
  env: NodeJS.ProcessEnv,
  probe: SocketProbe = nodeSocketProbe,
): ResolvedSocket {
  const explicit = explicitSocket(env);
  if (explicit !== undefined) {
    if (probe.exists(explicit.path)) {
      return explicit;
    }
    throw new RuntimeUnavailableError(
      `cannot reach container engine at ${explicit.path}: socket not found`,
    );
  }

  const candidates = [
    "/var/run/docker.sock",
    join(probe.homedir, ".docker", "run", "docker.sock"),
    podmanSocket(env, probe),
  ];
  for (const candidate of candidates) {
    if (probe.exists(candidate)) {
      return { path: candidate, source: "default" };
    }
  }

  throw new RuntimeUnavailableError(
    `no container engine socket found; tried ${candidates.join(", ")}; set PAAS_SOCKET`,
  );
}
