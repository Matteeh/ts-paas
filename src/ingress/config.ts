import { containerName } from "../deployments/types.js";
import { listApps } from "../state/apps.js";
import type { Store } from "../state/db.js";
import { deploymentHistory } from "../state/deployments.js";
import type { TlsMode } from "../state/settings.js";

/** One hostname routed to one upstream over `paas-net`. */
export interface IngressRoute {
  hostname: string;
  upstream: string;
}

/** Caddy's admin API JSON; the shape is Caddy's, not paas's. */
export type CaddyConfig = Record<string, unknown>;

/** Where Caddy's admin API listens inside `paas-caddy`. */
export const ADMIN_LISTEN = "0.0.0.0:2019";

function byHostname(a: IngressRoute, b: IngressRoute): number {
  if (a.hostname < b.hostname) {
    return -1;
  }
  return a.hostname > b.hostname ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

/**
 * Build Caddy's config from the TLS mode and the routes to serve. One HTTP
 * server, `paas`, holds one route per input route, ordered by hostname.
 */
export function buildCaddyConfig(
  tls: TlsMode,
  routes: readonly IngressRoute[],
): CaddyConfig {
  const server: Record<string, unknown> = {
    listen: [tls === "auto" ? ":443" : ":80"],
    routes: [...routes].sort(byHostname).map((route) => ({
      match: [{ host: [route.hostname] }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: route.upstream }],
        },
      ],
      terminal: true,
    })),
  };

  if (tls === "off") {
    server.automatic_https = { disable: true };
  }

  return {
    admin: { listen: ADMIN_LISTEN },
    apps: {
      http: {
        servers: {
          paas: server,
        },
      },
    },
  };
}

/**
 * The route each app should have right now: one per app with a hostname and a
 * running deployment, dialing the newest running deployment's container.
 */
export function desiredRoutes(store: Store): IngressRoute[] {
  const routes: IngressRoute[] = [];
  for (const app of listApps(store)) {
    if (app.hostname === null) {
      continue;
    }
    const running = deploymentHistory(store, app.name).find(
      (deployment) => deployment.status === "running",
    );
    if (running === undefined) {
      continue;
    }
    routes.push({
      hostname: app.hostname,
      upstream: `${containerName(app.name, running.id)}:${app.port}`,
    });
  }
  return routes;
}

/**
 * Read the routes back out of whatever `GET /config/` returned. Never throws:
 * a route missing its host or upstream is left out, and anything that is not
 * the config shape gives an empty list.
 */
export function routesFromConfig(config: unknown): IngressRoute[] {
  const root = asRecord(config);
  const apps = asRecord(root?.apps);
  const http = asRecord(apps?.http);
  const servers = asRecord(http?.servers);
  const paas = asRecord(servers?.paas);
  const rawRoutes = paas?.routes;
  if (!Array.isArray(rawRoutes)) {
    return [];
  }

  const routes: IngressRoute[] = [];
  for (const rawRoute of rawRoutes) {
    const route = asRecord(rawRoute);
    const match = asRecord(firstOf(route?.match));
    const host = firstOf(match?.host);
    if (typeof host !== "string") {
      continue;
    }
    const handle = asRecord(firstOf(route?.handle));
    const upstream = asRecord(firstOf(handle?.upstreams));
    const dial = upstream?.dial;
    if (typeof dial !== "string") {
      continue;
    }
    routes.push({ hostname: host, upstream: dial });
  }

  return routes.sort(byHostname);
}
