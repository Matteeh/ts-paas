import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FakeClock } from "../src/clock.js";
import { APP_LABEL } from "../src/deployments/types.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { openStore } from "../src/state/db.js";
import { deploymentHistory } from "../src/state/deployments.js";
import { stateDbPath } from "../src/state/paths.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-status-drift-cli-"));
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

/** Create app `web`, deploy it through the CLI and keep its running container. */
async function deployWeb(harness: Harness): Promise<string> {
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);
  const deployed = await deployAndAdvance(harness, ["deploy", "web"]);
  assert.equal(deployed.code, 0, deployed.err);
  const deployment = withStore(harness, (store) => deploymentHistory(store, "web")[0]!);
  return deployment.containerId!;
}

const WARNING_ONE =
  "paas: warning: state and engine disagree on 1 item(s); run paas reconcile --dry-run\n";
const WARNING_TWO =
  "paas: warning: state and engine disagree on 2 item(s); run paas reconcile --dry-run\n";

test("status with a healthy container writes no warning", async () => {
  const harness = makeHarness();
  await deployWeb(harness);

  const result = await invoke(harness, ["status"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  const webRow = result.out
    .trimEnd()
    .split("\n")
    .find((line) => line.startsWith("web"));
  assert.ok(webRow !== undefined, result.out);
  assert.ok(webRow.includes("running"), webRow);
});

test("status warns after the container disappears", async () => {
  const harness = makeHarness();
  await deployWeb(harness);
  await harness.runtime.removeContainer(
    withStore(harness, (store) => deploymentHistory(store, "web")[0]!.containerId!),
    { force: true },
  );

  const result = await invoke(harness, ["status"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, WARNING_ONE);
  const webRow = result.out
    .trimEnd()
    .split("\n")
    .find((line) => line.startsWith("web"));
  assert.ok(webRow !== undefined, result.out);
  assert.ok(webRow.includes("running"), webRow);
  assert.equal(
    withStore(harness, (store) => deploymentHistory(store, "web")[0]!.status),
    "running",
  );
});

test("status --json and status web --json keep stdout and warn", async () => {
  const harness = makeHarness();
  const containerId = await deployWeb(harness);

  const overviewBefore = await invoke(harness, ["status", "--json"]);
  const oneBefore = await invoke(harness, ["status", "web", "--json"]);
  assert.equal(overviewBefore.err, "");
  assert.equal(oneBefore.err, "");

  await harness.runtime.removeContainer(containerId, { force: true });

  const overviewAfter = await invoke(harness, ["status", "--json"]);
  const oneAfter = await invoke(harness, ["status", "web", "--json"]);

  assert.equal(overviewAfter.code, 0, overviewAfter.err);
  assert.equal(overviewAfter.out, overviewBefore.out);
  assert.equal(overviewAfter.err, WARNING_ONE);

  assert.equal(oneAfter.code, 0, oneAfter.err);
  assert.equal(oneAfter.out, oneBefore.out);
  assert.equal(oneAfter.err, WARNING_ONE);
});

test("an orphan plus a disappeared container warns about two items", async () => {
  const harness = makeHarness();
  const containerId = await deployWeb(harness);
  await harness.runtime.removeContainer(containerId, { force: true });
  await harness.runtime.pullImage("nginx:1");
  await harness.runtime.createContainer({
    name: "web-old",
    image: "nginx:1",
    labels: { [APP_LABEL]: "web" },
  });

  const result = await invoke(harness, ["status"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, WARNING_TWO);
});

test("an unavailable engine prints the table with no warning", async () => {
  const harness = makeHarness();
  await deployWeb(harness);
  harness.runtime.unavailable = true;

  const result = await invoke(harness, ["status"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.ok(result.out.includes("web"), result.out);

  const unknown = await invoke(harness, ["status", "nope"]);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.out, "");
  assert.equal(unknown.err, 'paas: app "nope" not found\n');
});
