import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { Io } from "../../src/output.js";
import { buildProgram, run } from "../../src/program.js";
import { DockerRuntime } from "../../src/runtime/docker.js";
import { ContainerNotFoundError } from "../../src/runtime/errors.js";
import { resolveSocket } from "../../src/runtime/socket.js";

/** Everything this run creates carries this label; the after hook removes it. */
const TEST_LABELS = { "paas.test": "e2e" };

const HTTP_PORT = 28080;
const HTTPS_PORT = 28443;
const HOST = "whoami.localhost";
const IMAGE = "docker.io/traefik/whoami:v1.11.0";

interface Capture {
  io: Io;
  out: string;
  err: string;
}

function capture(): Capture {
  const state = { out: "", err: "" };
  return {
    io: {
      out: (text) => {
        state.out += text;
      },
      err: (text) => {
        state.err += text;
      },
    },
    get out() {
      return state.out;
    },
    get err() {
      return state.err;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HttpResult {
  status: number;
  body: string;
}

/** GET `/` on Caddy's HTTP host port by address, with the hostname in Host. */
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
    await sleep(500);
  }
  throw new Error(`no 200 for Host: ${host} within 10s (${last})`);
}

if (process.env.PAAS_E2E !== "1") {
  test(
    "first real deploy",
    { skip: "set PAAS_E2E=1 to run" },
    () => {},
  );
} else {
  const socketPath = resolveSocket(process.env).path;
  const runtime = new DockerRuntime({
    socketPath,
    labels: TEST_LABELS,
  });

  // Refuse to start while the real paas ingress runs. Touch nothing: no
  // temp dir, no cleanup hook, only a failing test.
  let caddyExists = false;
  try {
    await runtime.inspectContainer("paas-caddy");
    caddyExists = true;
  } catch (error) {
    if (!(error instanceof ContainerNotFoundError)) {
      throw error;
    }
  }

  if (caddyExists) {
    test("first real deploy", () => {
      assert.fail(
        "paas-caddy already exists; bring real paas ingress down before running the e2e test",
      );
    });
  } else {
    const home = mkdtempSync(join(tmpdir(), "paas-e2e-"));

    after(async () => {
      try {
        await runtime.removeLabelled(TEST_LABELS);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("first real deploy", { timeout: 300_000 }, async () => {
      interface CommandResult {
        code: number;
        out: string;
        err: string;
      }

      const invoke = async (
        argv: readonly string[],
      ): Promise<CommandResult> => {
        const captureState = capture();
        const program = buildProgram(captureState.io, {
          env: { ...process.env, PAAS_HOME: home },
          runtime: () => runtime,
        });
        const code = await run(argv, captureState.io, program);
        return { code, out: captureState.out, err: captureState.err };
      };

      // 1. Bring the platform up on the test's host ports.
      const up = await invoke([
        "up",
        "--http-port",
        String(HTTP_PORT),
        "--https-port",
        String(HTTPS_PORT),
      ]);
      assert.equal(up.code, 0, up.err);

      // 2. Create the app.
      const created = await invoke([
        "apps",
        "create",
        "whoami",
        "--image",
        IMAGE,
        "--port",
        "80",
        "--host",
        HOST,
        "--env",
        "WHOAMI_NAME=blue",
      ]);
      assert.equal(created.code, 0, created.err);

      // 3. Deploy it.
      const first = await invoke(["deploy", "whoami"]);
      assert.equal(first.code, 0, first.err);

      // 4. Caddy serves it and the first colour is live.
      const blue = await waitFor200(HOST);
      assert.match(blue.body, /Name: blue/);

      // 5. Redeploy with a changed environment. Every request made while the
      //    deploy runs is answered, and the new value is live afterwards.
      const set = await invoke([
        "apps",
        "set",
        "whoami",
        "--env",
        "WHOAMI_NAME=green",
      ]);
      assert.equal(set.code, 0, set.err);

      const statuses: number[] = [];
      let deploying = true;
      const poller = (async () => {
        while (deploying) {
          try {
            statuses.push((await get(HOST)).status);
          } catch {
            statuses.push(0);
          }
          await sleep(100);
        }
      })();

      const second = await invoke(["deploy", "whoami"]);
      deploying = false;
      await poller;
      assert.equal(second.code, 0, second.err);
      assert.ok(
        statuses.length > 0,
        "no request was made while the redeploy ran",
      );
      for (const status of statuses) {
        assert.equal(status, 200);
      }

      const green = await waitFor200(HOST);
      assert.match(green.body, /Name: green/);

      // 6. Its logs reach the CLI.
      const logs = await invoke(["logs", "whoami"]);
      assert.equal(logs.code, 0, logs.err);
      assert.ok(
        `${logs.out}${logs.err}`.includes("Starting up on port 80"),
        `logs did not contain the startup line: ${logs.out}${logs.err}`,
      );

      // 7. Stop the app and bring ingress down.
      const stop = await invoke(["stop", "whoami"]);
      assert.equal(stop.code, 0, stop.err);

      const down = await invoke(["ingress", "down"]);
      assert.equal(down.code, 0, down.err);
    });
  }
}
