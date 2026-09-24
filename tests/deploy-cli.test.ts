import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeClock } from "../src/clock.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { FakeRuntime, type FakeImageScript } from "../src/runtime/fake.js";
import { getApp } from "../src/state/apps.js";
import { openStore } from "../src/state/db.js";
import { deploymentHistory } from "../src/state/deployments.js";
import { stateDbPath } from "../src/state/paths.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-deploy-cli-"));
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
  options: {
    env: NodeJS.ProcessEnv;
    runtime: () => FakeRuntime;
    clock: FakeClock;
  };
}

function makeHarness(
  scripts: Record<string, FakeImageScript> = {},
): Harness {
  const dir = tempDir();
  const clock = new FakeClock();
  const runtime = new FakeRuntime({ clock, scripts });
  return {
    dir,
    clock,
    runtime,
    options: { env: { PAAS_HOME: dir }, runtime: () => runtime, clock },
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

function withStore<T>(harness: Harness, fn: (store: ReturnType<typeof openStore>) => T): T {
  const store = openStore(stateDbPath({ PAAS_HOME: harness.dir }), {
    clock: harness.clock,
  });
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

test("help lists deploy, status, logs and stop with their descriptions", () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  const help = program.helpInformation();

  for (const [name, description] of [
    ["deploy", "deploy an app"],
    ["status", "show deployment status"],
    ["logs", "print an app's logs"],
    ["stop", "stop an app"],
  ]) {
    assert.ok(help.includes(name), `expected ${name} in help`);
    assert.ok(help.includes(description), `expected ${description} in help`);
  }
});

test("child process: deploy with an unreachable engine fails, status still exits 0", () => {
  const dir = tempDir();
  const socket = join(dir, "missing.sock");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, PAAS_HOME: dir, PAAS_SOCKET: socket };
  const runCli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      encoding: "utf8",
      env,
    });

  const created = runCli([
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);
  assert.equal(created.status, 0, created.stderr);

  const deploy = runCli(["deploy", "web"]);
  assert.equal(deploy.status, 1);
  assert.equal(deploy.stdout, "");
  assert.equal(
    deploy.stderr,
    `paas: cannot reach container engine at ${socket}: socket not found\n`,
  );

  const status = runCli(["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stderr, "");
  const webRow = status.stdout
    .trimEnd()
    .split("\n")
    .find((line) => line.startsWith("web"));
  assert.ok(webRow !== undefined, status.stdout);
  assert.ok(webRow.includes("-"), webRow);
});

test("deploy prints each progress line, the running line and exits 0", async () => {
  const harness = makeHarness();
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);

  const result = await deployAndAdvance(harness, ["deploy", "web"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  const lines = result.out.trimEnd().split("\n");
  const statuses = lines
    .map((line) => line.split(":")[0])
    .filter((value) =>
      ["pending", "pulling", "starting", "running"].includes(value),
    );
  assert.deepEqual(statuses, ["pending", "pulling", "starting", "running"]);

  const last = lines[lines.length - 1];
  const match = /^web is running \(deployment ([\da-f]+)\)$/.exec(last);
  assert.ok(match, last);

  const containers = await harness.runtime.listContainers({
    "paas.app": "web",
  });
  assert.equal(containers.length, 1);
  assert.equal(containers[0].state, "running");

  const latest = withStore(harness, (store) => deploymentHistory(store, "web")[0]);
  assert.equal(latest.status, "running");
  assert.equal(latest.id, match[1]);
});

test("a redeploy prints a replaced line", async () => {
  const harness = makeHarness();
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);
  await deployAndAdvance(harness, ["deploy", "web"]);

  const result = await deployAndAdvance(harness, ["deploy", "web"]);

  assert.equal(result.code, 0, result.err);
  assert.ok(
    result.out.split("\n").some((line) => line.startsWith("replaced: ")),
    result.out,
  );
});

test("deploy --image updates the app and the deployment uses the new image", async () => {
  const harness = makeHarness();
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);

  const result = await deployAndAdvance(harness, [
    "deploy",
    "web",
    "--image",
    "nginx:2",
  ]);

  assert.equal(result.code, 0, result.err);
  assert.equal(withStore(harness, (store) => getApp(store, "web")).image, "nginx:2");
  const latest = withStore(harness, (store) => deploymentHistory(store, "web")[0]);
  assert.equal(latest.image, "nginx:2");
});

test("deploy --json prints exactly one running record", async () => {
  const harness = makeHarness();
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);

  const result = await deployAndAdvance(harness, ["deploy", "web", "--json"]);

  assert.equal(result.code, 0, result.err);
  const lines = result.out.trimEnd().split("\n");
  assert.equal(lines.length, 1, result.out);
  const record = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(record), [
    "id",
    "app",
    "image",
    "status",
    "containerId",
    "error",
    "createdAt",
    "finishedAt",
  ]);
  assert.equal(record.app, "web");
  assert.equal(record.image, "nginx:1");
  assert.equal(record.status, "running");
  assert.equal(record.error, null);
});

test("a failed deploy prints the last 20 lines and keeps the previous running", async () => {
  const logs = Array.from({ length: 25 }, (_, index) => ({
    stream: "stdout" as const,
    text: `line ${index}`,
  }));
  const harness = makeHarness({
    "bad:1": { exitCode: 3, exitAfterMs: 1_000, logs },
  });
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);
  await deployAndAdvance(harness, ["deploy", "web"]);

  const result = await deployAndAdvance(harness, [
    "deploy",
    "web",
    "--image",
    "bad:1",
  ]);

  assert.equal(result.code, 1);
  const pipeLines = result.out
    .split("\n")
    .filter((line) => line.startsWith("  | "));
  assert.equal(pipeLines.length, 20, result.out);
  assert.deepEqual(
    pipeLines.map((line) => line.slice(4)),
    logs.slice(-20).map((entry) => entry.text),
  );
  assert.match(
    result.err,
    /^paas: deployment [\da-f]+ failed: container exited with code 3\n$/,
  );

  const history = withStore(harness, (store) => deploymentHistory(store, "web"));
  assert.equal(history[0].status, "failed");
  assert.equal(history[1].status, "running");
  const containers = await harness.runtime.listContainers({
    "paas.app": "web",
  });
  assert.equal(containers.length, 1);
  assert.equal(containers[0].state, "running");
});

test("deploy --json on failure prints one failed record and exits 1", async () => {
  const logs = Array.from({ length: 25 }, (_, index) => ({
    stream: "stdout" as const,
    text: `line ${index}`,
  }));
  const harness = makeHarness({
    "bad:1": { exitCode: 3, exitAfterMs: 1_000, logs },
  });
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);
  await deployAndAdvance(harness, ["deploy", "web"]);

  const result = await deployAndAdvance(harness, [
    "deploy",
    "web",
    "--image",
    "bad:1",
    "--json",
  ]);

  assert.equal(result.code, 1);
  const lines = result.out.trimEnd().split("\n");
  assert.equal(lines.length, 1, result.out);
  const record = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(record.status, "failed");
  assert.ok(String(record.error).startsWith("container exited with code 3\n"));
  assert.match(result.err, /^paas: deployment [\da-f]+ failed: /);
});

test("deploy --image with whitespace is a usage error", async () => {
  const harness = makeHarness();
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);

  const result = await invoke(harness, ["deploy", "web", "--image", "a b"]);

  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.ok(
    result.err.startsWith('paas: invalid image reference "a b"'),
    result.err,
  );
});
