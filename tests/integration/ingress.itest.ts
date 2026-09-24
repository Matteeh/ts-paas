import assert from "node:assert/strict";
import { request } from "node:http";
import { after, test } from "node:test";

import { systemClock } from "../../src/clock.js";
import { deploy } from "../../src/deployments/engine.js";
import { HttpCaddyAdmin } from "../../src/ingress/admin.js";
import { ingressUp, syncIngress } from "../../src/ingress/caddy.js";
import { DockerRuntime } from "../../src/runtime/docker.js";
import { resolveSocket } from "../../src/runtime/socket.js";
import { createApp } from "../../src/state/apps.js";
import { openStore } from "../../src/state/db.js";

/** The integration test's own Caddy target, apart from the real `paas-caddy`. */
const HTTP_PORT = 18080;
const HTTPS_PORT = 18443;
const ADMIN_PORT = 12019;
const ADMIN_URL = "http://127.0.0.1:12019";

/**
 * Everything this run creates carries this label, kept apart from the
 * contract suite's `paas.test=true` so the two files can run in parallel.
 */
const TEST_LABELS = { "paas.test": "ingress" };

if (process.env.PAAS_INTEGRATION !== "1") {
  test(
    "ingress integration",
    { skip: "set PAAS_INTEGRATION=1 to run" },
    () => {},
  );
} else {
  const socketPath = resolveSocket(process.env).path;
  const runtime = new DockerRuntime({
    socketPath,
    labels: TEST_LABELS,
  });

  after(async () => {
    await runtime.removeLabelled(TEST_LABELS);
  });

  interface HttpResult {
    status: number;
    body: string;
  }

  /**
   * GET `/` on Caddy's HTTP host port by address, so the test does not depend
   * on name resolution. The hostname comes from the `Host` header.
   */
  function get(host: string): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: HTTP_PORT,
          path: "/",
          method: "GET",
          headers: { Host: host },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  /** Retry the request every 500 ms, for up to 10 s, until it is a 200. */
  async function waitFor200(host: string): Promise<HttpResult> {
    const deadline = Date.now() + 10_000;
    let last = "no attempt";
    while (Date.now() <= deadline) {
      try {
        const response = await get(host);
        if (response.status === 200) {
          return response;
        }
        last = `status ${response.status}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`no 200 for Host: ${host} within 10s (${last})`);
  }

  test(
    "ingress integration",
    { timeout: 120_000 },
    async () => {
      const store = openStore(":memory:", { clock: systemClock });
      const target = {
        container: "paas-test-caddy",
        volume: "paas-test-caddy-data",
        adminPort: ADMIN_PORT,
      };
      const deps = {
        store,
        runtime,
        clock: systemClock,
        admin: new HttpCaddyAdmin(ADMIN_URL),
        target,
      };

      createApp(store, {
        name: "whoami",
        image: "docker.io/traefik/whoami:v1.11.0",
        port: 80,
        hostname: "whoami.localhost",
      });

      await ingressUp(deps, {
        httpPort: HTTP_PORT,
        httpsPort: HTTPS_PORT,
      });

      const deployment = await deploy(
        { store, runtime, clock: systemClock },
        "whoami",
        {
          onRunning: async () => {
            await syncIngress(deps);
          },
        },
      );
      assert.equal(deployment.status, "running");

      const routed = await waitFor200("whoami.localhost");
      assert.match(routed.body, /Hostname: /);

      const unmatched = await get("other.localhost");
      assert.ok(
        !unmatched.body.includes("Hostname: "),
        "other.localhost must not be routed to whoami",
      );
    },
  );
}
