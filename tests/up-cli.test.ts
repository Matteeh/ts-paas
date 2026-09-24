import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeClock } from "../src/clock.js";
import { PAAS_NETWORK } from "../src/deployments/types.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { openStore } from "../src/state/db.js";
import { stateDbPath } from "../src/state/paths.js";
import { getIngressSettings } from "../src/state/settings.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-up-cli-"));
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

const DOCTOR_LINES = [
  "socket:   -",
  "engine:   fake 0.0.0",
  "api:      -",
  "paas-net: present",
];

const NEXT_LINE =
  "next: paas apps create <name> --image <ref> --port <n> --host <name>.localhost";

test("paas up brings the platform up on a fresh machine", async () => {
  const harness = makeHarness();

  const result = await invoke(harness, ["up"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.equal(
    result.out,
    [
      ...DOCTOR_LINES,
      "ingress is up (created): http 80, https 443, tls off, routes 0",
      NEXT_LINE,
    ].join("\n") + "\n",
  );

  assert.equal(await harness.runtime.networkExists(PAAS_NETWORK), true);
  const caddy = await harness.runtime.listContainers({
    "paas.ingress": "caddy",
  });
  assert.equal(caddy.length, 1);
  assert.equal(caddy[0].state, "running");
  assert.equal(harness.admin.loads.length, 1);
});

test("a second paas up prints the same doctor lines and unchanged ingress", async () => {
  const harness = makeHarness();
  await invoke(harness, ["up"]);

  const second = await invoke(harness, ["up"]);

  assert.equal(second.code, 0, second.err);
  assert.equal(
    second.out,
    [
      ...DOCTOR_LINES,
      "ingress is up (unchanged): http 80, https 443, tls off, routes 0",
      NEXT_LINE,
    ].join("\n") + "\n",
  );
});

test("paas up passes its flags through to ingress and stores them", async () => {
  const harness = makeHarness();

  const result = await invoke(harness, [
    "up",
    "--http-port",
    "8080",
    "--https-port",
    "8443",
    "--tls",
    "auto",
  ]);

  assert.equal(result.code, 0, result.err);
  assert.equal(
    result.out,
    [
      ...DOCTOR_LINES,
      "ingress is up (created): http 8080, https 8443, tls auto, routes 0",
      NEXT_LINE,
    ].join("\n") + "\n",
  );

  const status = await invoke(harness, ["ingress", "status"]);
  assert.equal(status.code, 0, status.err);
  assert.equal(
    status.out,
    [
      "caddy:    running",
      "tls:      auto",
      "http:     8080",
      "https:    8443",
      "routes:   0",
    ].join("\n") + "\n",
  );
});

test("invalid paas up values are usage errors that create no Caddy", async () => {
  for (const argv of [
    ["up", "--tls", "on"],
    ["up", "--http-port", "abc"],
  ]) {
    const harness = makeHarness();
    const result = await invoke(harness, argv);

    assert.equal(result.code, 2, `${argv.join(" ")}: ${result.err}`);
    assert.ok(result.err.startsWith("paas: "), result.err);
    assert.equal(result.out, "");

    const caddy = await harness.runtime.listContainers({
      "paas.ingress": "caddy",
    });
    assert.equal(caddy.length, 0, `${argv.join(" ")} created a container`);
  }
});

test("child process: paas up with an unreachable engine creates no state", () => {
  const dir = tempDir();
  const socket = join(dir, "missing.sock");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, PAAS_HOME: dir, PAAS_SOCKET: socket };

  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "up"], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `paas: cannot reach container engine at ${socket}: socket not found\n`,
  );
  assert.equal(existsSync(stateDbPath({ PAAS_HOME: dir })), false);
});

test("paas --help lists up with a one-line description", () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  const help = program.helpInformation();

  const line = help
    .split("\n")
    .find((candidate) => candidate.trimStart().startsWith("up"));
  assert.ok(line !== undefined, help);
  assert.ok(/\S\s+\S/.test(line.slice(2)), line);
});

test("up makes the ingress settings visible through the store", async () => {
  const harness = makeHarness();
  await invoke(harness, ["up", "--http-port", "8080", "--https-port", "8443"]);

  const store = openStore(stateDbPath({ PAAS_HOME: harness.dir }), {
    clock: harness.clock,
  });
  try {
    assert.deepEqual(getIngressSettings(store), {
      tls: "off",
      httpPort: 8080,
      httpsPort: 8443,
    });
  } finally {
    store.close();
  }
});
