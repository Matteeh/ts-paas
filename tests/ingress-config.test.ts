import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock } from "../src/clock.js";
import {
  ADMIN_LISTEN,
  type IngressRoute,
  buildCaddyConfig,
  desiredRoutes,
  routesFromConfig,
} from "../src/ingress/config.js";
import { createApp } from "../src/state/apps.js";
import { openStore, type Store } from "../src/state/db.js";
import {
  createDeployment,
  setDeploymentStatus,
} from "../src/state/deployments.js";

const BASE = "2026-01-01T00:00:00.000Z";

function newStore(): Store {
  const clock = new FakeClock(new Date(BASE));
  let n = 0;
  return openStore(":memory:", { clock, newId: () => `d${++n}` });
}

const WEB_ROUTE: IngressRoute = {
  hostname: "web.localhost",
  upstream: "web-abc123:8080",
};

test("buildCaddyConfig in mode off builds the exact plain-HTTP config", () => {
  assert.deepEqual(buildCaddyConfig("off", [WEB_ROUTE]), {
    admin: { listen: "0.0.0.0:2019" },
    apps: {
      http: {
        servers: {
          paas: {
            listen: [":80"],
            automatic_https: { disable: true },
            routes: [
              {
                match: [{ host: ["web.localhost"] }],
                handle: [
                  {
                    handler: "reverse_proxy",
                    upstreams: [{ dial: "web-abc123:8080" }],
                  },
                ],
                terminal: true,
              },
            ],
          },
        },
      },
    },
  });
  assert.equal(ADMIN_LISTEN, "0.0.0.0:2019");
});

test("buildCaddyConfig in mode auto listens on 443 and keeps no automatic_https", () => {
  const config = buildCaddyConfig("auto", [WEB_ROUTE]);
  const server = (
    (config.apps as Record<string, unknown>).http as Record<string, unknown>
  ).servers as Record<string, unknown>;
  const paas = server.paas as Record<string, unknown>;

  assert.deepEqual(paas.listen, [":443"]);
  assert.equal("automatic_https" in paas, false);
  assert.deepEqual(config.admin, { listen: "0.0.0.0:2019" });
});

test("buildCaddyConfig orders routes by hostname whatever the input order", () => {
  const config = buildCaddyConfig("off", [
    { hostname: "b.localhost", upstream: "b-1:80" },
    { hostname: "a.localhost", upstream: "a-1:80" },
    { hostname: "c.localhost", upstream: "c-1:80" },
  ]);
  const routes = (
    ((
      (config.apps as Record<string, unknown>).http as Record<string, unknown>
    ).servers as Record<string, unknown>).paas as Record<string, unknown>
  ).routes as Array<Record<string, unknown>>;

  assert.deepEqual(
    routes.map((route) => (route.match as Array<{ host: string[] }>)[0]!.host[0]),
    ["a.localhost", "b.localhost", "c.localhost"],
  );
});

test("buildCaddyConfig with no routes gives an empty route list", () => {
  const config = buildCaddyConfig("off", []);
  const paas = (
    ((
      (config.apps as Record<string, unknown>).http as Record<string, unknown>
    ).servers as Record<string, unknown>).paas as Record<string, unknown>
  );
  assert.deepEqual(paas.routes, []);
});

test("desiredRoutes dials the newest running deployment of each hosted app", () => {
  const store = newStore();
  try {
    createApp(store, {
      name: "web",
      image: "nginx:1",
      port: 8080,
      hostname: "web.localhost",
    });
    createDeployment(store, { app: "web", image: "nginx:1" });
    setDeploymentStatus(store, "d1", "running", { containerId: "c1" });
    createDeployment(store, { app: "web", image: "nginx:2" });
    setDeploymentStatus(store, "d2", "running", { containerId: "c2" });

    assert.deepEqual(desiredRoutes(store), [
      { hostname: "web.localhost", upstream: "web-d2:8080" },
    ]);
  } finally {
    store.close();
  }
});

test("desiredRoutes skips apps with no hostname or no running deployment", () => {
  const store = newStore();
  try {
    createApp(store, { name: "api", image: "api:1", port: 3000 });
    createDeployment(store, { app: "api", image: "api:1" });
    setDeploymentStatus(store, "d1", "running", { containerId: "c1" });

    createApp(store, {
      name: "old",
      image: "old:1",
      port: 8080,
      hostname: "old.localhost",
    });
    createDeployment(store, { app: "old", image: "old:1" });
    setDeploymentStatus(store, "d2", "stopped");

    assert.deepEqual(desiredRoutes(store), []);
  } finally {
    store.close();
  }
});

test("routesFromConfig round-trips a built config in both TLS modes, sorted", () => {
  const routes: IngressRoute[] = [
    { hostname: "b.localhost", upstream: "b-1:80" },
    { hostname: "a.localhost", upstream: "a-1:80" },
  ];
  const sorted = [...routes].sort((a, b) =>
    a.hostname < b.hostname ? -1 : 1,
  );

  assert.deepEqual(routesFromConfig(buildCaddyConfig("off", routes)), sorted);
  assert.deepEqual(routesFromConfig(buildCaddyConfig("auto", routes)), sorted);
});

test("routesFromConfig never throws on missing or malformed data", () => {
  assert.deepEqual(routesFromConfig(null), []);
  assert.deepEqual(routesFromConfig({}), []);
  assert.deepEqual(
    routesFromConfig({
      apps: {
        http: {
          servers: {
            paas: {
              routes: [{ handle: [] }],
            },
          },
        },
      },
    }),
    [],
  );

  assert.deepEqual(
    routesFromConfig({
      apps: {
        http: {
          servers: {
            paas: {
              routes: [
                { handle: [] },
                "not a route",
                { match: [] },
                {
                  match: [{ host: ["web.localhost"] }],
                  handle: [
                    {
                      handler: "reverse_proxy",
                      upstreams: [{ dial: "web-1:80" }],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    }),
    [{ hostname: "web.localhost", upstream: "web-1:80" }],
  );
});
