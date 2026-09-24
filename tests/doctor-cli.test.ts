import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { fileURLToPath } from "node:url";

import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import type { ContainerRuntime, EngineInfo } from "../src/runtime/types.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-doctor-cli-"));
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

async function runDoctor(
  argv: readonly string[],
  runtime?: () => ContainerRuntime,
): Promise<{ code: number; out: string; err: string }> {
  const captureState = capture();
  const program = buildProgram(
    captureState.io,
    runtime === undefined ? {} : { runtime },
  );
  const code = await run(argv, captureState.io, program);
  return { code, out: captureState.out, err: captureState.err };
}

const FAKE_REPORT =
  "socket:   -\nengine:   fake 0.0.0\napi:      -\npaas-net: missing\n";

test("doctor on the fake prints the four lines and exits 0", async () => {
  const result = await runDoctor(["doctor"], () => new FakeRuntime());

  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.equal(result.out, FAKE_REPORT);
});

test("doctor reports the network as present once it exists", async () => {
  const fake = new FakeRuntime();
  await fake.ensureNetwork("paas-net");

  const result = await runDoctor(["doctor"], () => fake);

  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.ok(result.out.endsWith("paas-net: present\n"), result.out);
});

test("doctor --json prints the report object", async () => {
  const result = await runDoctor(["doctor", "--json"], () => new FakeRuntime());

  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.equal(
    result.out,
    '{"socket":null,"engine":"fake","version":"0.0.0","apiVersion":null,"paasNet":false}\n',
  );
});

class EngineInfoFake extends FakeRuntime {
  ensureNetworkCalls = 0;

  override async ensureNetwork(name: string): Promise<void> {
    this.ensureNetworkCalls += 1;
    return super.ensureNetwork(name);
  }

  override async ping(): Promise<EngineInfo> {
    return {
      ...(await super.ping()),
      apiVersion: "1.47",
      endpoint: "/tmp/x.sock",
    };
  }
}

test("doctor prints the endpoint and API version without creating the network", async () => {
  const fake = new EngineInfoFake();

  const result = await runDoctor(["doctor"], () => fake);

  assert.equal(result.code, 0);
  const lines = result.out.split("\n");
  assert.equal(lines[0], "socket:   /tmp/x.sock");
  assert.equal(lines[2], "api:      1.47");
  assert.equal(fake.ensureNetworkCalls, 0);
});

test("child process: doctor with a missing socket exits 1 and leaves no state", () => {
  const dir = tempDir();
  const socket = join(dir, "missing.sock");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const env = { ...process.env, PAAS_HOME: dir, PAAS_SOCKET: socket };

  const result = spawnSync(process.execPath, ["--import", "tsx", cli, "doctor"], {
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    `paas: cannot reach container engine at ${socket}: socket not found\n`,
  );
  assert.equal(existsSync(join(dir, "state.db")), false);
});

test("help lists doctor with its description", () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  const help = program.helpInformation();

  assert.ok(help.includes("doctor"), "expected doctor in help");
  assert.ok(
    help.includes("check the container engine"),
    "expected the doctor description in help",
  );
});

test("no source file references the old no-runtime message", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const offenders: string[] = [];

  for (const entry of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".ts")) {
      continue;
    }
    const text = readFileSync(join(srcDir, entry), "utf8");
    if (
      text.includes("NO_RUNTIME_MESSAGE") ||
      text.includes("no container runtime is configured yet")
    ) {
      offenders.push(entry);
    }
  }

  assert.deepEqual(offenders, []);
});
