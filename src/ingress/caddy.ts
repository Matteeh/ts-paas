import type { Clock } from "../clock.js";
import {
  DEFAULT_STOP_TIMEOUT_SECONDS,
  PAAS_NETWORK,
} from "../deployments/types.js";
import { ContainerNotFoundError } from "../runtime/errors.js";
import type {
  ContainerInfo,
  ContainerRuntime,
  ContainerSpec,
} from "../runtime/types.js";
import type { Store } from "../state/db.js";
import type { IngressSettings } from "../state/settings.js";
import { getIngressSettings, setIngressSettings } from "../state/settings.js";
import type { CaddyAdmin } from "./admin.js";
import { AdminUnreachableError } from "./admin.js";
import type { IngressRoute } from "./config.js";
import {
  ADMIN_LISTEN,
  buildCaddyConfig,
  desiredRoutes,
  routesFromConfig,
} from "./config.js";

/** The Caddy image paas runs, fully qualified for Podman's short-name rules. */
export const CADDY_IMAGE = "docker.io/library/caddy:2";

/** Where and how paas names the Caddy container. */
export interface IngressTarget {
  container: string;
  volume: string;
  adminPort: number;
}

/** The container, volume and admin port paas uses outside the integration test. */
export const DEFAULT_TARGET: IngressTarget = {
  container: "paas-caddy",
  volume: "paas-caddy-data",
  adminPort: 2019,
};

/** Everything the Caddy lifecycle needs, injected. */
export interface IngressDeps {
  store: Store;
  runtime: ContainerRuntime;
  clock: Clock;
  admin: CaddyAdmin;
  target?: IngressTarget;
}

/** What `ingressUp` did to the container. */
export type UpAction = "created" | "recreated" | "started" | "unchanged";

export interface UpResult {
  action: UpAction;
  settings: IngressSettings;
  routes: IngressRoute[];
}

export interface IngressStatus {
  caddy: "running" | "stopped" | "missing";
  settings: IngressSettings;
  routes: IngressRoute[] | null;
}

const CADDY_LABEL = "paas.ingress";
const HTTP_PORT_LABEL = "paas.ingress.http-port";
const HTTPS_PORT_LABEL = "paas.ingress.https-port";
const CADDY_ADMIN_ENV = "CADDY_ADMIN";
const CADDY_DATA_PATH = "/data";
const HTTP_CONTAINER_PORT = 80;
const HTTPS_CONTAINER_PORT = 443;
const ADMIN_CONTAINER_PORT = 2019;
const ADMIN_HOST_IP = "127.0.0.1";
const RETRY_DELAY_MS = 250;
const MAX_RETRIES = 40;

function target(deps: IngressDeps): IngressTarget {
  return deps.target ?? DEFAULT_TARGET;
}

async function inspectContainer(
  runtime: ContainerRuntime,
  name: string,
): Promise<ContainerInfo | undefined> {
  try {
    return await runtime.inspectContainer(name);
  } catch (error) {
    if (error instanceof ContainerNotFoundError) {
      return undefined;
    }
    throw error;
  }
}

function labelsMatch(info: ContainerInfo, settings: IngressSettings): boolean {
  return (
    info.labels[HTTP_PORT_LABEL] === String(settings.httpPort) &&
    info.labels[HTTPS_PORT_LABEL] === String(settings.httpsPort)
  );
}

function caddySpec(
  target: IngressTarget,
  settings: IngressSettings,
): ContainerSpec {
  return {
    name: target.container,
    image: CADDY_IMAGE,
    env: { [CADDY_ADMIN_ENV]: ADMIN_LISTEN },
    labels: {
      [CADDY_LABEL]: "caddy",
      [HTTP_PORT_LABEL]: String(settings.httpPort),
      [HTTPS_PORT_LABEL]: String(settings.httpsPort),
    },
    network: PAAS_NETWORK,
    restartPolicy: "unless-stopped",
    publish: [
      { hostIp: "", hostPort: settings.httpPort, containerPort: HTTP_CONTAINER_PORT },
      { hostIp: "", hostPort: settings.httpsPort, containerPort: HTTPS_CONTAINER_PORT },
      {
        hostIp: ADMIN_HOST_IP,
        hostPort: target.adminPort,
        containerPort: ADMIN_CONTAINER_PORT,
      },
    ],
    volumes: [{ volume: target.volume, path: CADDY_DATA_PATH }],
  };
}

async function createCaddy(
  deps: IngressDeps,
  target: IngressTarget,
  settings: IngressSettings,
): Promise<void> {
  await deps.runtime.pullImage(CADDY_IMAGE);
  await deps.runtime.ensureNetwork(PAAS_NETWORK);
  await deps.runtime.ensureVolume(target.volume);
  const id = await deps.runtime.createContainer(caddySpec(target, settings));
  await deps.runtime.startContainer(id);
}

/** Push a config, retrying only while the admin API is unreachable. */
async function pushConfig(
  deps: IngressDeps,
  settings: IngressSettings,
  retrying: boolean,
): Promise<void> {
  const config = buildCaddyConfig(settings.tls, desiredRoutes(deps.store));

  if (!retrying) {
    await deps.admin.load(config);
    return;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await deps.admin.load(config);
      return;
    } catch (error) {
      if (!(error instanceof AdminUnreachableError)) {
        throw error;
      }
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await deps.clock.sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

/**
 * Store the given settings, ensure `paas-caddy` runs with them, then push the
 * config. An invalid setting fails before any runtime call.
 */
export async function ingressUp(
  deps: IngressDeps,
  changes: Partial<IngressSettings> = {},
): Promise<UpResult> {
  const settings = setIngressSettings(deps.store, changes);
  const target = deps.target ?? DEFAULT_TARGET;

  const existing = await inspectContainer(deps.runtime, target.container);
  let action: UpAction;
  if (existing === undefined) {
    await createCaddy(deps, target, settings);
    action = "created";
  } else if (!labelsMatch(existing, settings)) {
    await deps.runtime.removeContainer(target.container, { force: true });
    await createCaddy(deps, target, settings);
    action = "recreated";
  } else if (existing.state === "running") {
    action = "unchanged";
  } else {
    await deps.runtime.startContainer(target.container);
    action = "started";
  }

  await pushConfig(deps, settings, true);
  return { action, settings, routes: desiredRoutes(deps.store) };
}

/** Stop and remove `paas-caddy`, keeping its volume. */
export async function ingressDown(deps: IngressDeps): Promise<boolean> {
  const target = deps.target ?? DEFAULT_TARGET;
  const existing = await inspectContainer(deps.runtime, target.container);
  if (existing === undefined) {
    return false;
  }
  await deps.runtime.stopContainer(target.container, {
    timeoutSeconds: DEFAULT_STOP_TIMEOUT_SECONDS,
  });
  await deps.runtime.removeContainer(target.container);
  return true;
}

/** Push the current config once, but only while `paas-caddy` is running. */
export async function syncIngress(deps: IngressDeps): Promise<boolean> {
  const target = deps.target ?? DEFAULT_TARGET;
  const existing = await inspectContainer(deps.runtime, target.container);
  if (existing === undefined || existing.state !== "running") {
    return false;
  }
  const settings = getIngressSettings(deps.store);
  await deps.admin.load(
    buildCaddyConfig(settings.tls, desiredRoutes(deps.store)),
  );
  return true;
}

/** Report the container, the stored settings and, while up, Caddy's routes. */
export async function ingressStatus(
  deps: IngressDeps,
): Promise<IngressStatus> {
  const target = deps.target ?? DEFAULT_TARGET;
  const settings = getIngressSettings(deps.store);
  const existing = await inspectContainer(deps.runtime, target.container);
  if (existing === undefined) {
    return { caddy: "missing", settings, routes: null };
  }
  if (existing.state !== "running") {
    return { caddy: "stopped", settings, routes: null };
  }
  const config = await deps.admin.getConfig();
  return { caddy: "running", settings, routes: routesFromConfig(config) };
}
