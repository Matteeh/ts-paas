import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FakeClock } from "../src/clock.js";
import { containerName } from "../src/deployments/types.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { createApp } from "../src/state/apps.js";
import { openStore } from "../src/state/db.js";
import {
  createDeployment,
  setDeploymentStatus,
} from "../src/state/deployments.js";
import { stateDbPath } from "../src/state/paths.js";
import {
  DEFAULT_INGRESS_SETTINGS,
  getIngressSettings,
} from "../src/state/settings.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-ingress-cli-"));
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

/** Create app `web` with a hostname and one running deployment. */
function seedWeb(harness: Harness): string {
  return withStore(harness, (store) => {
    createApp(store, {
      name: "web",
      image: "nginx:1",
      port: 8080,
      hostname: "web.localhost",
    });
    const deployment = createDeployment(store, {
      app: "web",
      image: "nginx:1",
    });
    setDeploymentStatus(store, deployment.id, "running");
    return deployment.id;
  });
}

test("paas ingress alone prints its help to stderr and exits 2", async () => {
  const harness = makeHarness();
  const result = await invoke(harness, ["ingress"]);

  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.ok(result.err.includes("Usage: paas ingress"), result.err);
  for (const name of ["up", "down", "status"]) {
    assert.ok(result.err.includes(name), `expected ${name} in help`);
  }
});

test("paas ingress --help lists each subcommand with its description", async () => {
  const harness = makeHarness();
  const result = await invoke(harness, ["ingress", "--help"]);

  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.ok(result.out.includes("Usage: paas ingress"), result.out);
  for (const name of ["up", "down", "status"]) {
    assert.ok(result.out.includes(name), `expected ${name}`);
  }
  for (const command of ["up", "down", "status"]) {
    const line = result.out
      .split("\n")
      .find((candidate) => candidate.trimStart().startsWith(command));
    assert.ok(line !== undefined, `expected a ${command} line`);
    assert.ok(/\S\s+\S/.test(line.slice(command.length)), line);
  }
});

test("ingress up creates and then reports unchanged", async () => {
  const harness = makeHarness();

  const first = await invoke(harness, ["ingress", "up"]);
  assert.equal(first.code, 0, first.err);
  assert.equal(first.err, "");
  assert.equal(
    first.out,
    "ingress is up (created): http 80, https 443, tls off, routes 0\n",
  );

  const second = await invoke(harness, ["ingress", "up"]);
  assert.equal(second.code, 0, second.err);
  assert.equal(
    second.out,
    "ingress is up (unchanged): http 80, https 443, tls off, routes 0\n",
  );
});

test("ingress up stores the flags and a later bare up keeps them", async () => {
  const harness = makeHarness();

  const flagged = await invoke(harness, [
    "ingress",
    "up",
    "--http-port",
    "8080",
    "--https-port",
    "8443",
    "--tls",
    "auto",
  ]);
  assert.equal(flagged.code, 0, flagged.err);
  assert.equal(
    flagged.out,
    "ingress is up (created): http 8080, https 8443, tls auto, routes 0\n",
  );

  const bare = await invoke(harness, ["ingress", "up"]);
  assert.equal(bare.code, 0, bare.err);
  assert.equal(
    bare.out,
    "ingress is up (unchanged): http 8080, https 8443, tls auto, routes 0\n",
  );
});

test("invalid ingress up values are usage errors that change nothing", async () => {
  for (const argv of [
    ["ingress", "up", "--tls", "on"],
    ["ingress", "up", "--http-port", "abc"],
    ["ingress", "up", "--http-port", "0"],
  ]) {
    const harness = makeHarness();
    const result = await invoke(harness, argv);

    assert.equal(result.code, 2, `${argv.join(" ")}: ${result.err}`);
    assert.ok(result.err.startsWith("paas: "), result.err);

    const containers = await harness.runtime.listContainers({
      "paas.ingress": "caddy",
    });
    assert.equal(containers.length, 0, `${argv.join(" ")} created a container`);

    const settings = withStore(harness, (store) => getIngressSettings(store));
    assert.deepEqual(settings, DEFAULT_INGRESS_SETTINGS, argv.join(" "));
  }
});

test("ingress up prints the route count and status shows the route", async () => {
  const harness = makeHarness();
  const id = seedWeb(harness);

  const up = await invoke(harness, ["ingress", "up"]);
  assert.equal(up.code, 0, up.err);
  assert.equal(
    up.out,
    "ingress is up (created): http 80, https 443, tls off, routes 1\n",
  );

  const status = await invoke(harness, ["ingress", "status"]);
  assert.equal(status.code, 0, status.err);
  assert.equal(
    status.out,
    [
      "caddy:    running",
      "tls:      off",
      "http:     80",
      "https:    443",
      "routes:   1",
      `  web.localhost -> ${containerName("web", id)}:8080`,
    ].join("\n") + "\n",
  );
});

test("ingress status without Caddy prints the five lines and JSON", async () => {
  const harness = makeHarness();

  const status = await invoke(harness, ["ingress", "status"]);
  assert.equal(status.code, 0, status.err);
  assert.equal(status.err, "");
  assert.equal(
    status.out,
    [
      "caddy:    missing",
      "tls:      off",
      "http:     80",
      "https:    443",
      "routes:   -",
    ].join("\n") + "\n",
  );

  const json = await invoke(harness, ["ingress", "status", "--json"]);
  assert.equal(json.code, 0, json.err);
  assert.equal(
    json.out,
    '{"caddy":"missing","tls":"off","httpPort":80,"httpsPort":443,"routes":null}\n',
  );
});

test("ingress down removes once and then reports nothing to remove", async () => {
  const harness = makeHarness();
  await invoke(harness, ["ingress", "up"]);

  const first = await invoke(harness, ["ingress", "down"]);
  assert.equal(first.code, 0, first.err);
  assert.equal(
    first.out,
    "removed paas-caddy; kept volume paas-caddy-data\n",
  );

  const second = await invoke(harness, ["ingress", "down"]);
  assert.equal(second.code, 0, second.err);
  assert.equal(second.out, "paas-caddy does not exist\n");

  const containers = await harness.runtime.listContainers({
    "paas.ingress": "caddy",
  });
  assert.equal(containers.length, 0);
});
