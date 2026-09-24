import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FakeClock } from "../src/clock.js";
import { containerName } from "../src/deployments/types.js";
import { AdminRequestError } from "../src/ingress/admin.js";
import type { CaddyConfig } from "../src/ingress/config.js";
import { routesFromConfig } from "../src/ingress/config.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { openStore } from "../src/state/db.js";
import { deploymentHistory } from "../src/state/deployments.js";
import { stateDbPath } from "../src/state/paths.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-ingress-deploy-cli-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

interface CommandResult {
  code: number;
  out: string;
  err: string;
}

interface Harness {
  dir: string;
  clock: FakeClock;
  runtime: FakeRuntime;
  admin: FakeCaddyAdmin;
  options: {
    env: NodeJS.ProcessEnv;
    runtime: () => FakeRuntime;
    clock: FakeClock;
    admin: () => FakeCaddyAdmin;
  };
}

function makeHarness(): Harness {
  const dir = tempDir();
  const clock = new FakeClock();
  const runtime = new FakeRuntime({ clock });
  const admin = new FakeCaddyAdmin();
  return {
    dir,
    clock,
    runtime,
    admin,
    options: {
      env: { PAAS_HOME: dir },
      runtime: () => runtime,
      clock,
      admin: () => admin,
    },
  };
}

async function invoke(
  harness: Harness,
  argv: readonly string[],
): Promise<CommandResult> {
  const captureState = capture();
  const program = buildProgram(captureState.io, harness.options);
  const code = await run(argv, captureState.io, program);
  return { code, out: captureState.out, err: captureState.err };
}

async function flush(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Start a deploy without awaiting, let the engine reach its health sleep,
 * advance the fake clock, then await the command.
 */
async function deployAndAdvance(
  harness: Harness,
  argv: readonly string[],
  advanceMs = 3_000,
): Promise<CommandResult> {
  const captureState = capture();
  const program = buildProgram(captureState.io, harness.options);
  const promise = run(argv, captureState.io, program);
  await flush();
  await harness.clock.advance(advanceMs);
  const code = await promise;
  return { code, out: captureState.out, err: captureState.err };
}

function withStore<T>(
  harness: Harness,
  fn: (store: ReturnType<typeof openStore>) => T,
): T {
  const store = openStore(stateDbPath({ PAAS_HOME: harness.dir }), {
    clock: harness.clock,
  });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** Create app `web` with a hostname and bring ingress up. */
async function setupWeb(harness: Harness): Promise<void> {
  const created = await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "8080",
    "--host",
    "web.localhost",
  ]);
  assert.equal(created.code, 0, created.err);

  const up = await invoke(harness, ["ingress", "up"]);
  assert.equal(up.code, 0, up.err);
}

function recordRouteViolations(harness: Harness): string[] {
  const violations: string[] = [];
  harness.admin.onLoad = async (config: CaddyConfig) => {
    for (const route of routesFromConfig(config)) {
      const name = route.upstream.split(":")[0] ?? "";
      try {
        const info = await harness.runtime.inspectContainer(name);
        if (info.state !== "running") {
          violations.push(`${route.upstream}:${info.state}`);
        }
      } catch {
        violations.push(`${route.upstream}:missing`);
      }
    }
  };
  return violations;
}

test("deploy with ingress up pushes the new route", async () => {
  const harness = makeHarness();
  await setupWeb(harness);

  const result = await deployAndAdvance(harness, ["deploy", "web"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");

  const last = harness.admin.loads.at(-1);
  assert.ok(last !== undefined, "expected a pushed config");
  const routes = routesFromConfig(last);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].hostname, "web.localhost");

  const history = withStore(harness, (store) => deploymentHistory(store, "web"));
  assert.equal(history[0].status, "running");
  assert.equal(routes[0].upstream, `${containerName("web", history[0].id)}:8080`);
});

test("redeploy never routes to a container that is not running", async () => {
  const harness = makeHarness();
  const violations = recordRouteViolations(harness);
  await setupWeb(harness);

  const first = await deployAndAdvance(harness, ["deploy", "web"]);
  assert.equal(first.code, 0, first.err);

  const second = await deployAndAdvance(harness, ["deploy", "web"]);
  assert.equal(second.code, 0, second.err);

  assert.deepEqual(violations, []);

  const last = harness.admin.loads.at(-1);
  assert.ok(last !== undefined, "expected a pushed config");
  const routes = routesFromConfig(last);
  assert.equal(routes.length, 1);

  const history = withStore(harness, (store) => deploymentHistory(store, "web"));
  assert.equal(history[0].status, "running");
  assert.equal(history[1].status, "replaced");
  assert.equal(routes[0].upstream, `${containerName("web", history[0].id)}:8080`);
});

test("a failed redeploy push exits 1 and keeps both deployments running", async () => {
  const harness = makeHarness();
  await setupWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);

  harness.admin.failures.push(
    new AdminRequestError(500, "Caddy admin API answered 500: boom"),
  );

  const result = await deployAndAdvance(harness, ["deploy", "web"]);

  const history = withStore(harness, (store) => deploymentHistory(store, "web"));
  const newest = history[0];
  assert.equal(newest.status, "running");
  assert.equal(history[1].status, "running");

  assert.equal(result.code, 1);
  assert.equal(
    result.err,
    `paas: deployment ${newest.id} is running, but ingress update failed: Caddy admin API answered 500: boom\n`,
  );

  const newContainer = await harness.runtime.inspectContainer(
    containerName("web", newest.id),
  );
  assert.equal(newContainer.state, "running");
  const previousContainer = await harness.runtime.inspectContainer(
    containerName("web", history[1].id),
  );
  assert.equal(previousContainer.state, "running");
});

test("a failed redeploy push with --json prints the running record and exits 1", async () => {
  const harness = makeHarness();
  await setupWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);

  harness.admin.failures.push(
    new AdminRequestError(500, "Caddy admin API answered 500: boom"),
  );

  const result = await deployAndAdvance(harness, ["deploy", "web", "--json"]);

  const history = withStore(harness, (store) => deploymentHistory(store, "web"));
  const newest = history[0];
  assert.equal(newest.status, "running");

  assert.equal(result.code, 1);
  const lines = result.out.trimEnd().split("\n");
  assert.equal(lines.length, 1, result.out);
  const record = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(record.status, "running");
  assert.equal(record.id, newest.id);
  assert.equal(
    result.err,
    `paas: deployment ${newest.id} is running, but ingress update failed: Caddy admin API answered 500: boom\n`,
  );
});

test("stop with ingress up pushes a config with no route", async () => {
  const harness = makeHarness();
  await setupWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);

  const result = await invoke(harness, ["stop", "web"]);

  const history = withStore(harness, (store) => deploymentHistory(store, "web"));
  assert.equal(history[0].status, "stopped");

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.equal(result.out, `stopped web (deployment ${history[0].id})\n`);

  const last = harness.admin.loads.at(-1);
  assert.ok(last !== undefined, "expected a pushed config");
  assert.deepEqual(routesFromConfig(last), []);
});

test("a failed ingress push after stop keeps the stopped line and exits 1", async () => {
  const harness = makeHarness();
  await setupWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);

  harness.admin.failures.push(
    new AdminRequestError(500, "Caddy admin API answered 500: boom"),
  );

  const result = await invoke(harness, ["stop", "web"]);

  const history = withStore(harness, (store) => deploymentHistory(store, "web"));
  assert.equal(history[0].status, "stopped");

  assert.equal(result.code, 1);
  assert.equal(result.out, `stopped web (deployment ${history[0].id})\n`);
  assert.equal(
    result.err,
    "paas: web is stopped, but ingress update failed: Caddy admin API answered 500: boom\n",
  );
});

test("without ingress up, deploy and stop exit 0 and push no config", async () => {
  const harness = makeHarness();
  const created = await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "8080",
    "--host",
    "web.localhost",
  ]);
  assert.equal(created.code, 0, created.err);

  const deployed = await deployAndAdvance(harness, ["deploy", "web"]);
  assert.equal(deployed.code, 0, deployed.err);

  const stopped = await invoke(harness, ["stop", "web"]);
  assert.equal(stopped.code, 0, stopped.err);

  assert.equal(harness.admin.loads.length, 0);
});
