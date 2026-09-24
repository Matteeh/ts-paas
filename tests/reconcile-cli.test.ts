import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FakeClock } from "../src/clock.js";
import { APP_LABEL } from "../src/deployments/types.js";
import { buildCaddyConfig, routesFromConfig } from "../src/ingress/config.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { openStore } from "../src/state/db.js";
import {
  createDeployment,
  deploymentHistory,
  deploymentStatusChanges,
  setDeploymentStatus,
} from "../src/state/deployments.js";
import { stateDbPath } from "../src/state/paths.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-reconcile-cli-"));
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

class RemoveFailingRuntime extends FakeRuntime {
  failName: string | null = null;

  override async removeContainer(
    idOrName: string,
    options?: { force?: boolean },
  ): Promise<void> {
    if (this.failName !== null && idOrName === this.failName) {
      throw new RuntimeError("device busy");
    }
    return super.removeContainer(idOrName, options);
  }
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
 * Start a command without awaiting, let the engine reach its health sleep,
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

/**
 * Like {@link deployAndAdvance}, but keeps advancing while the command runs
 * so a redeploy buried behind the plan and apply steps still sees the window.
 */
async function runAdvancing(
  harness: Harness,
  argv: readonly string[],
  advanceMs = 3_000,
): Promise<CommandResult> {
  const captureState = capture();
  const program = buildProgram(captureState.io, harness.options);
  let settled = false;
  const promise = run(argv, captureState.io, program).then((code) => {
    settled = true;
    return code;
  });
  for (let i = 0; i < 50 && !settled; i += 1) {
    await flush();
    await harness.clock.advance(advanceMs);
  }
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

/** Create app `web` with a hostname, without bringing ingress up. */
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

/** Create app `web` and bring ingress up. */
async function setupWeb(harness: Harness): Promise<void> {
  await createWeb(harness);
  const up = await invoke(harness, ["ingress", "up"]);
  assert.equal(up.code, 0, up.err);
}

/** Add a leftover managed container labelled with `app`, and return its id. */
async function addOrphan(
  harness: Harness,
  name: string,
  app: string,
): Promise<string> {
  await harness.runtime.pullImage("nginx:1");
  return harness.runtime.createContainer({
    name,
    image: "nginx:1",
    labels: { [APP_LABEL]: app },
  });
}

function onlyDeployment(harness: Harness, app: string) {
  const history = withStore(harness, (store) => deploymentHistory(store, app));
  assert.ok(history.length > 0, `expected a deployment for ${app}`);
  return history[0]!;
}

test("reconcile with everything in place prints nothing to reconcile", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  const deployed = await deployAndAdvance(harness, ["deploy", "web"]);
  assert.equal(deployed.code, 0, deployed.err);

  const result = await invoke(harness, ["reconcile"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "nothing to reconcile\n");
  assert.equal(result.err, "");
});

test("help lists reconcile with a description", async () => {
  const harness = makeHarness();

  const result = await invoke(harness, ["--help"]);

  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /\breconcile\b/);
  assert.match(result.out, /bring state and the engine back into agreement/);
});

test("reconcile fails a deployment whose container disappeared", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);
  const deployment = onlyDeployment(harness, "web");
  await harness.runtime.removeContainer(deployment.containerId!, { force: true });

  const result = await invoke(harness, ["reconcile"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(
    result.out,
    `fail: web deployment ${deployment.id} (container disappeared)\n`,
  );
  assert.equal(onlyDeployment(harness, "web").status, "failed");
});

test("--dry-run --prune --redeploy changes nothing", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);
  const deployment = onlyDeployment(harness, "web");
  await harness.runtime.removeContainer(deployment.containerId!, { force: true });

  const result = await invoke(harness, [
    "reconcile",
    "--dry-run",
    "--prune",
    "--redeploy",
  ]);

  assert.equal(result.code, 0, result.err);
  assert.equal(
    result.out,
    "dry run: nothing was changed\n" +
      `fail: web deployment ${deployment.id} (container disappeared)\n` +
      "redeploy: web (planned)\n",
  );
  assert.equal(onlyDeployment(harness, "web").status, "running");
});

test("--redeploy deploys again an app that lost its container", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);
  const previous = onlyDeployment(harness, "web");
  await harness.runtime.removeContainer(previous.containerId!, { force: true });

  const result = await runAdvancing(harness, ["reconcile", "--redeploy"]);

  assert.equal(result.code, 0, result.err);
  const newest = onlyDeployment(harness, "web");
  assert.notEqual(newest.id, previous.id);
  assert.equal(newest.status, "running");
  assert.equal(
    result.out,
    `fail: web deployment ${previous.id} (container disappeared)\n` +
      `redeploy: web (deployment ${newest.id} is running)\n`,
  );
});

test("a stuck deployment fails but is not redeployed", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  const stuck = withStore(harness, (store) => {
    const deployment = createDeployment(store, {
      app: "web",
      image: "nginx:1",
    });
    setDeploymentStatus(store, deployment.id, "pulling");
    const changes = deploymentStatusChanges(store, deployment.id);
    return { id: deployment.id, at: changes[changes.length - 1]!.at };
  });
  await harness.clock.advance(600_001);

  const result = await invoke(harness, ["reconcile", "--redeploy"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(
    result.out,
    `fail: web deployment ${stuck.id} (stuck in pulling since ${stuck.at})\n`,
  );
  assert.ok(!result.out.includes("redeploy:"));
});

test("an orphan is reported and left alone without --prune", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  const containerId = await addOrphan(harness, "web-old", "web");

  const result = await invoke(harness, ["reconcile"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(
    result.out,
    "orphan: web-old (app web; use --prune to remove)\n",
  );
  assert.equal(
    (await harness.runtime.inspectContainer(containerId)).state,
    "created",
  );
});

test("--prune removes an orphan", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await addOrphan(harness, "web-old", "web");

  const result = await invoke(harness, ["reconcile", "--prune"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "prune: web-old (removed)\n");
  await assert.rejects(() => harness.runtime.inspectContainer("web-old"));
});

test("a failed prune exits 1 and reports the error", async () => {
  const harness = makeHarness((clock) => new RemoveFailingRuntime({ clock }));
  await createWeb(harness);
  const containerId = await addOrphan(harness, "web-old", "web");
  (harness.runtime as RemoveFailingRuntime).failName = containerId;

  const result = await invoke(harness, ["reconcile", "--prune"]);

  assert.equal(result.code, 1);
  assert.equal(result.out, "prune: web-old (failed: device busy)\n");
  assert.equal(result.err, "paas: reconcile had 1 failed item(s)\n");
  assert.equal(
    (await harness.runtime.inspectContainer("web-old")).state,
    "created",
  );
});

test("reconcile pushes ingress when Caddy lost its routes", async () => {
  const harness = makeHarness();
  await setupWeb(harness);
  const deployed = await deployAndAdvance(harness, ["deploy", "web"]);
  assert.equal(deployed.code, 0, deployed.err);

  await harness.admin.load(buildCaddyConfig("off", []));

  const result = await invoke(harness, ["reconcile"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, "push-ingress: paas-caddy (1 routes)\n");
  const routes = routesFromConfig(harness.admin.loads.at(-1));
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.hostname, "web.localhost");

  const loads = harness.admin.loads.length;
  const again = await invoke(harness, ["reconcile"]);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.out, "nothing to reconcile\n");
  assert.equal(harness.admin.loads.length, loads);
});

test("reconcile pushes ingress after failing a disappeared container", async () => {
  const harness = makeHarness();
  await setupWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);
  const deployment = onlyDeployment(harness, "web");
  await harness.runtime.removeContainer(deployment.containerId!, { force: true });

  const result = await invoke(harness, ["reconcile"]);

  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.out.trimEnd().split("\n"), [
    `fail: web deployment ${deployment.id} (container disappeared)`,
    "push-ingress: paas-caddy (0 routes)",
  ]);
  assert.deepEqual(routesFromConfig(harness.admin.loads.at(-1)), []);
});

test("--dry-run --json reports the planned fail item and changes nothing", async () => {
  const harness = makeHarness();
  await createWeb(harness);
  await deployAndAdvance(harness, ["deploy", "web"]);
  const deployment = onlyDeployment(harness, "web");
  await harness.runtime.removeContainer(deployment.containerId!, { force: true });

  const dry = await invoke(harness, ["reconcile", "--dry-run", "--json"]);

  assert.equal(dry.code, 0, dry.err);
  const lines = dry.out.trimEnd().split("\n");
  assert.equal(lines.length, 1, dry.out);
  const parsed = JSON.parse(lines[0]!) as {
    dryRun: boolean;
    items: Array<Record<string, unknown>>;
  };
  assert.equal(parsed.dryRun, true);
  const fail = parsed.items.find((item) => item.kind === "fail")!;
  assert.equal(fail.detail, "container disappeared");
  assert.equal(fail.ok, null);
  assert.equal(fail.app, "web");
  assert.equal(fail.deploymentId, deployment.id);
  assert.equal(fail.containerId, deployment.containerId);
  assert.deepEqual(Object.keys(fail).sort(), [
    "app",
    "containerId",
    "deploymentId",
    "detail",
    "kind",
    "ok",
  ]);
  assert.equal(onlyDeployment(harness, "web").status, "running");

  const real = await invoke(harness, ["reconcile", "--json"]);

  assert.equal(real.code, 0, real.err);
  const realParsed = JSON.parse(real.out.trimEnd()) as {
    dryRun: boolean;
    items: Array<Record<string, unknown>>;
  };
  assert.equal(realParsed.dryRun, false);
  const realFail = realParsed.items.find((item) => item.kind === "fail")!;
  assert.equal(realFail.detail, "container disappeared");
  assert.equal(realFail.ok, true);
});
