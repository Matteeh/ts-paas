import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FakeClock } from "../src/clock.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { FakeRuntime, type FakeImageScript } from "../src/runtime/fake.js";
import { openStore } from "../src/state/db.js";
import {
  createDeployment,
  deploymentHistory,
  setDeploymentStatus,
  type DeploymentStatus,
} from "../src/state/deployments.js";
import { stateDbPath } from "../src/state/paths.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-status-logs-cli-"));
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

/** Seed a deployment directly through the store, on the shared clock. */
function seedDeployment(
  harness: Harness,
  app: string,
  options: {
    image: string;
    status?: DeploymentStatus;
    containerId?: string;
    error?: string;
  },
): string {
  const store = openStore(stateDbPath({ PAAS_HOME: harness.dir }), {
    clock: harness.clock,
  });
  try {
    const deployment = createDeployment(store, { app, image: options.image });
    if (options.status !== undefined) {
      setDeploymentStatus(store, deployment.id, options.status, {
        containerId: options.containerId,
        error: options.error,
      });
    }
    return deployment.id;
  } finally {
    store.close();
  }
}

test("status prints the aligned overview with uptime and dashes", async () => {
  const harness = makeHarness();
  await invoke(harness, [
    "apps",
    "create",
    "api",
    "--image",
    "redis:7",
    "--port",
    "6379",
  ]);
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);
  seedDeployment(harness, "web", {
    image: "nginx:1",
    status: "running",
    containerId: "abcdef0123456789",
  });
  await harness.clock.advance(125_000);

  const result = await invoke(harness, ["status"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(
    result.err,
    "paas: warning: state and engine disagree on 1 item(s); run paas reconcile --dry-run\n",
  );
  const lines = result.out.trimEnd().split("\n");
  assert.equal(
    lines[0].replace(/ +/g, " ").trim(),
    "APP STATUS CONTAINER IMAGE UPTIME",
  );
  assert.equal(lines.length, 3);

  const apiLine = lines.find((line) => line.startsWith("api"));
  const webLine = lines.find((line) => line.startsWith("web"));
  assert.ok(apiLine !== undefined, result.out);
  assert.ok(webLine !== undefined, result.out);
  assert.ok(apiLine.includes("redis:7"), apiLine);
  assert.ok(apiLine.includes("-"), apiLine);
  assert.ok(webLine.includes("running"), webLine);
  assert.ok(webLine.includes("abcdef012345"), webLine);
  assert.ok(webLine.includes("nginx:1"), webLine);
  assert.ok(webLine.includes("2m 5s"), webLine);
  assert.ok(lines.indexOf(apiLine) < lines.indexOf(webLine), result.out);
});

test("status --json prints the contracted array with nulls and full ids", async () => {
  const harness = makeHarness();
  await invoke(harness, [
    "apps",
    "create",
    "api",
    "--image",
    "redis:7",
    "--port",
    "6379",
  ]);
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);
  const id = seedDeployment(harness, "web", {
    image: "nginx:1",
    status: "running",
    containerId: "abcdef0123456789",
  });
  await harness.clock.advance(125_000);

  const result = await invoke(harness, ["status", "--json"]);

  assert.equal(result.code, 0, result.err);
  const rows = JSON.parse(result.out) as Record<string, unknown>[];
  assert.equal(rows.length, 2);

  const api = rows.find((row) => row.app === "api");
  assert.ok(api !== undefined, result.out);
  assert.deepEqual(Object.keys(api).sort(), [
    "app",
    "containerId",
    "deploymentId",
    "image",
    "runningSince",
    "status",
    "uptimeSeconds",
  ]);
  assert.equal(api.status, null);
  assert.equal(api.deploymentId, null);
  assert.equal(api.containerId, null);
  assert.equal(api.runningSince, null);
  assert.equal(api.uptimeSeconds, null);
  assert.equal(api.image, "redis:7");

  const web = rows.find((row) => row.app === "web");
  assert.ok(web !== undefined, result.out);
  assert.equal(web.status, "running");
  assert.equal(web.deploymentId, id);
  assert.equal(web.containerId, "abcdef0123456789");
  assert.equal(web.uptimeSeconds, 125);
  assert.equal(typeof web.runningSince, "string");
});

test("status prints no apps and [] when there are none", async () => {
  const harness = makeHarness();

  const human = await invoke(harness, ["status"]);
  assert.equal(human.code, 0);
  assert.equal(human.err, "");
  assert.equal(human.out, "no apps\n");

  const json = await invoke(harness, ["status", "--json"]);
  assert.equal(json.code, 0);
  assert.equal(json.err, "");
  assert.equal(json.out, "[]\n");
});

test("status web prints the overview, a blank line and the five newest", async () => {
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
  const older: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    older.push(seedDeployment(harness, "web", { image: "nginx:1", status: "stopped" }));
  }
  const failedId = seedDeployment(harness, "web", {
    image: "nginx:2",
    status: "failed",
    error: "boom\nstack trace",
  });
  const runningId = seedDeployment(harness, "web", {
    image: "nginx:3",
    status: "running",
    containerId: "abcdef0123456789",
  });

  const result = await invoke(harness, ["status", "web"]);

  assert.equal(result.code, 0, result.err);
  const lines = result.out.split("\n");
  assert.equal(lines[2], "");
  assert.equal(
    lines[3].replace(/ +/g, " ").trim(),
    "ID STATUS IMAGE CREATED FINISHED ERROR",
  );
  const rows = lines.slice(4).filter((line) => line !== "");
  assert.equal(rows.length, 5, result.out);
  assert.ok(rows[0].startsWith(runningId), rows[0]);
  assert.ok(rows[1].startsWith(failedId), rows[1]);
  assert.ok(rows[1].includes("boom"), rows[1]);
  assert.ok(!rows[1].includes("stack trace"), rows[1]);
  assert.ok(rows[2].startsWith(older[4]), rows[2]);
  assert.ok(rows[3].startsWith(older[3]), rows[3]);
  assert.ok(rows[4].startsWith(older[2]), rows[4]);
});

test("status web --json adds the five newest deployment records", async () => {
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
  for (let i = 0; i < 5; i += 1) {
    seedDeployment(harness, "web", { image: "nginx:1", status: "stopped" });
  }
  const failedId = seedDeployment(harness, "web", {
    image: "nginx:2",
    status: "failed",
    error: "boom\nstack trace",
  });
  const runningId = seedDeployment(harness, "web", {
    image: "nginx:3",
    status: "running",
    containerId: "abcdef0123456789",
  });

  const result = await invoke(harness, ["status", "web", "--json"]);

  assert.equal(result.code, 0, result.err);
  const value = JSON.parse(result.out) as Record<string, unknown>;
  assert.equal(value.app, "web");
  assert.equal(value.status, "running");
  const deployments = value.deployments as Record<string, unknown>[];
  assert.equal(deployments.length, 5);
  assert.equal(deployments[0].id, runningId);
  assert.equal(deployments[0].status, "running");
  assert.equal(deployments[1].id, failedId);
  assert.equal(deployments[1].error, "boom\nstack trace");
});

test("status of an unknown app is an operation failure", async () => {
  const harness = makeHarness();

  const result = await invoke(harness, ["status", "nope"]);

  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.equal(result.err, 'paas: app "nope" not found\n');
});

function logsHarness(
  logs: FakeImageScript["logs"],
): Harness {
  return makeHarness({ "logs:1": { logs } });
}

async function deployLogsApp(harness: Harness): Promise<void> {
  await invoke(harness, [
    "apps",
    "create",
    "web",
    "--image",
    "logs:1",
    "--port",
    "80",
  ]);
  await deployAndAdvance(harness, ["deploy", "web"]);
}

test("logs routes stdout to out and stderr to err", async () => {
  const harness = logsHarness([
    { stream: "stdout", text: "out1" },
    { stream: "stderr", text: "err1" },
  ]);
  await deployLogsApp(harness);

  const result = await invoke(harness, ["logs", "web"]);

  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes("out1"), result.out);
  assert.ok(!result.out.includes("err1"), result.out);
  assert.ok(result.err.includes("err1"), result.err);
  assert.ok(!result.err.includes("out1"), result.err);
});

test("logs --tail keeps only the newest entries", async () => {
  const harness = logsHarness([
    { stream: "stdout", text: "out1" },
    { stream: "stdout", text: "out2" },
    { stream: "stdout", text: "out3" },
  ]);
  await deployLogsApp(harness);

  const result = await invoke(harness, ["logs", "web", "--tail", "1"]);

  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes("out3"), result.out);
  assert.ok(!result.out.includes("out1"), result.out);
  assert.ok(!result.out.includes("out2"), result.out);
});

test("logs --since filters by the injected clock", async () => {
  const harness = logsHarness([
    { stream: "stdout", text: "out1" },
    { stream: "stderr", text: "err1" },
  ]);
  await deployLogsApp(harness);
  await harness.clock.advance(120_000);

  const recent = await invoke(harness, ["logs", "web", "--since", "1m"]);
  assert.equal(recent.code, 0, recent.err);
  assert.equal(recent.out, "");
  assert.equal(recent.err, "");

  const all = await invoke(harness, ["logs", "web", "--since", "5m"]);
  assert.equal(all.code, 0, all.err);
  assert.ok(all.out.includes("out1"), all.out);
  assert.ok(all.err.includes("err1"), all.err);
});

test("logs --json prints stream, time and text entries", async () => {
  const harness = logsHarness([
    { stream: "stdout", text: "out1" },
    { stream: "stderr", text: "err1" },
  ]);
  await deployLogsApp(harness);

  const result = await invoke(harness, ["logs", "web", "--json"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  const entries = JSON.parse(result.out) as Record<string, unknown>[];
  assert.equal(entries.length, 2);
  assert.deepEqual(Object.keys(entries[0]).sort(), ["stream", "text", "time"]);
  assert.equal(entries[0].stream, "stdout");
  assert.equal(entries[0].text, "out1");
  assert.equal(typeof entries[0].time, "string");
  assert.equal(entries[1].stream, "stderr");
  assert.equal(entries[1].text, "err1");
});

test("logs --since with a bad duration is a usage error", async () => {
  const harness = makeHarness();

  const result = await invoke(harness, ["logs", "web", "--since", "5x"]);

  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.ok(
    result.err.startsWith('paas: invalid duration "5x"'),
    result.err,
  );
});

test("logs for an app without a running deployment fails", async () => {
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

  const result = await invoke(harness, ["logs", "web"]);

  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.equal(result.err, 'paas: app "web" has no running deployment\n');
});

test("stop stops the app, prints its deployment and refuses a second stop", async () => {
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
  const store = openStore(stateDbPath({ PAAS_HOME: harness.dir }), {
    clock: harness.clock,
  });
  let id: string;
  try {
    id = deploymentHistory(store, "web")[0].id;
  } finally {
    store.close();
  }

  const result = await invoke(harness, ["stop", "web"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.equal(result.out, `stopped web (deployment ${id})\n`);
  assert.equal(
    (await harness.runtime.listContainers({ "paas.app": "web" })).length,
    0,
  );

  const second = await invoke(harness, ["stop", "web"]);
  assert.equal(second.code, 1);
  assert.equal(second.out, "");
  assert.equal(
    second.err,
    'paas: app "web" has no running deployment\n',
  );
});
