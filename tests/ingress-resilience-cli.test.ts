import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FakeClock } from "../src/clock.js";
import { explainError } from "../src/commands/context.js";
import { routesFromConfig } from "../src/ingress/config.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { PortInUseError } from "../src/runtime/errors.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { openStore } from "../src/state/db.js";
import { deploymentHistory } from "../src/state/deployments.js";
import { stateDbPath } from "../src/state/paths.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-ingress-resilience-cli-"));
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

/** A runtime whose Caddy start fails with a busy port while `busy` is set. */
class PortInUseRuntime extends FakeRuntime {
  busy = false;

  override async startContainer(idOrName: string): Promise<void> {
    if (this.busy) {
      const info = await this.inspectContainer(idOrName).catch(() => undefined);
      if (info?.name === "paas-caddy") {
        throw new PortInUseError(
          "rootlessport listen tcp 127.0.0.1:2019: bind: address already in use",
          "127.0.0.1:2019",
        );
      }
    }
    return super.startContainer(idOrName);
  }
}

function makeHarness(
  runtimeFactory: (clock: FakeClock) => FakeRuntime = (clock) =>
    new FakeRuntime({ clock }),
): Harness {
  const dir = tempDir();
  const clock = new FakeClock();
  const runtime = runtimeFactory(clock);
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

/** Start a command, let the engine reach its health sleep, advance, then await. */
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

/** Create app `web` with a hostname. */
async function createWeb(harness: Harness): Promise<void> {
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
}

/** Create app `web`, bring ingress up and deploy a running container. */
async function setupRunningWeb(harness: Harness): Promise<void> {
  await createWeb(harness);
  const up = await invoke(harness, ["ingress", "up"]);
  assert.equal(up.code, 0, up.err);
  const deployed = await deployAndAdvance(harness, ["deploy", "web"]);
  assert.equal(deployed.code, 0, deployed.err);
}

function onlyDeployment(harness: Harness, app: string) {
  const history = withStore(harness, (store) => deploymentHistory(store, app));
  assert.ok(history.length > 0, `expected a deployment for ${app}`);
  return history[0]!;
}

const PODMAN_HINT =
  ' (on rootless Podman a leftover containers-rootlessport process can hold it; see docs/manual-testing.md)';
const BUSY_2019 = `host port 127.0.0.1:2019 is already in use; find what holds it with "ss -ltnp | grep :2019"${PODMAN_HINT}`;
const BUSY_2019_STDERR = `paas: ${BUSY_2019}\n`;

test("reconcile starts a stopped Caddy and pushes its config", async () => {
  const harness = makeHarness();
  await setupRunningWeb(harness);
  await harness.runtime.stopContainer("paas-caddy");

  const result = await invoke(harness, ["reconcile"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "start-ingress: paas-caddy (started, 1 routes)\n");
  assert.ok(!result.out.includes("push-ingress"), result.out);
  assert.equal(
    (await harness.runtime.inspectContainer("paas-caddy")).state,
    "running",
  );
  const routes = routesFromConfig(harness.admin.loads.at(-1));
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.hostname, "web.localhost");
});

test("reconcile --dry-run plans start-ingress and leaves Caddy stopped", async () => {
  const harness = makeHarness();
  await setupRunningWeb(harness);
  await harness.runtime.stopContainer("paas-caddy");

  const dry = await invoke(harness, ["reconcile", "--dry-run"]);

  assert.equal(dry.code, 0, dry.err);
  assert.equal(
    dry.out,
    "dry run: nothing was changed\nstart-ingress: paas-caddy (planned)\n",
  );
  assert.equal(
    (await harness.runtime.inspectContainer("paas-caddy")).state,
    "exited",
  );

  const json = await invoke(harness, ["reconcile", "--dry-run", "--json"]);

  assert.equal(json.code, 0, json.err);
  const parsed = JSON.parse(json.out.trimEnd()) as {
    dryRun: boolean;
    items: Array<Record<string, unknown>>;
  };
  assert.equal(parsed.dryRun, true);
  const item = parsed.items.find((entry) => entry.kind === "start-ingress")!;
  assert.equal(item.detail, "planned");
  assert.equal(item.ok, null);
  assert.equal(item.app, null);
  assert.equal(item.deploymentId, null);
  assert.equal(item.containerId, null);
});

test("status warns when Caddy is stopped; reconcile with no Caddy does nothing", async () => {
  const harness = makeHarness();
  await setupRunningWeb(harness);
  await harness.runtime.stopContainer("paas-caddy");

  const status = await invoke(harness, ["status"]);

  assert.equal(status.code, 0, status.err);
  assert.equal(
    status.err,
    "paas: warning: state and engine disagree on 1 item(s); run paas reconcile --dry-run\n",
  );

  await harness.runtime.removeContainer("paas-caddy", { force: true });
  const again = await invoke(harness, ["reconcile"]);

  assert.equal(again.code, 0, again.err);
  assert.equal(again.out, "nothing to reconcile\n");
});

test("reconcile reports a busy-port start failure and pushes nothing", async () => {
  const harness = makeHarness((clock) => new PortInUseRuntime({ clock }));
  await setupRunningWeb(harness);
  await harness.runtime.stopContainer("paas-caddy");
  const runtime = harness.runtime as PortInUseRuntime;
  runtime.busy = true;
  const loads = harness.admin.loads.length;

  const result = await invoke(harness, ["reconcile"]);

  assert.equal(result.code, 1);
  assert.equal(
    result.out,
    `start-ingress: paas-caddy (failed: ${BUSY_2019})\n`,
  );
  assert.equal(result.err, "paas: reconcile had 1 failed item(s)\n");
  assert.equal(harness.admin.loads.length, loads);
});

test("paas up on a busy port prints the busy-port message and leaves no Caddy", async () => {
  const harness = makeHarness((clock) => new PortInUseRuntime({ clock }));
  (harness.runtime as PortInUseRuntime).busy = true;

  const result = await invoke(harness, ["up"]);

  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.equal(result.err, BUSY_2019_STDERR);
  await assert.rejects(() => harness.runtime.inspectContainer("paas-caddy"));
});

test("explainError names the busy port and falls back for other errors", () => {
  const withAddress = new PortInUseError(
    "rootlessport listen tcp 127.0.0.1:2019: bind: address already in use",
    "127.0.0.1:2019",
  );
  assert.equal(explainError(withAddress), BUSY_2019);

  const noAddress = new PortInUseError(
    "listen tcp :2019: bind: address already in use",
    null,
  );
  assert.equal(
    explainError(noAddress),
    `a host port is already in use (listen tcp :2019: bind: address already in use); find what holds it with "ss -ltnp"${PODMAN_HINT}`,
  );

  assert.equal(explainError(new Error("boom")), "boom");
});

test("an app and a running container are untouched by the start-ingress item", async () => {
  const harness = makeHarness();
  await setupRunningWeb(harness);
  const deployment = onlyDeployment(harness, "web");
  await harness.runtime.stopContainer("paas-caddy");

  const result = await invoke(harness, ["reconcile"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(onlyDeployment(harness, "web").id, deployment.id);
  assert.equal(
    (await harness.runtime.inspectContainer(deployment.containerId!)).state,
    "running",
  );
});
