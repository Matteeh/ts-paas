import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { FakeClock } from "../src/clock.js";
import type { Command } from "commander";

import {
  contextClock,
  defaultRuntimeFactory,
  runAction,
  withEngine,
  withStore,
  type CommandContext,
} from "../src/commands/context.js";
import {
  formatUptime,
  parseDuration,
  parseTail,
  shortContainerId,
} from "../src/commands/deploy-helpers.js";
import { UsageError } from "../src/errors.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { DockerRuntime } from "../src/runtime/docker.js";
import { RuntimeUnavailableError } from "../src/runtime/errors.js";
import { createApp, getApp } from "../src/state/apps.js";
import type { Store } from "../src/state/db.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-commands-runtime-"));
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

// A context of just `{ io, env }` must typecheck: every added field is optional.
const minimalContext: CommandContext = { io: capture().io, env: {} };

test("a CommandContext of just io and env is accepted", () => {
  assert.equal(minimalContext.runtime, undefined);
  assert.equal(minimalContext.clock, undefined);
});

test("defaultRuntimeFactory returns the Docker adapter on an existing socket", () => {
  const dir = tempDir();
  const socket = join(dir, "docker.sock");
  writeFileSync(socket, "");

  const runtime = defaultRuntimeFactory({ PAAS_SOCKET: socket });

  assert.ok(runtime instanceof DockerRuntime);
  assert.equal(runtime.socketPath, socket);
});

test("defaultRuntimeFactory throws the adapter's message for a missing socket", () => {
  const dir = tempDir();
  const socket = join(dir, "missing.sock");

  assert.throws(
    () => defaultRuntimeFactory({ PAAS_SOCKET: socket }),
    (error: unknown) =>
      error instanceof RuntimeUnavailableError &&
      error.message ===
        `cannot reach container engine at ${socket}: socket not found`,
  );
});

test("contextClock falls back to the system clock and keeps an injected clock", () => {
  const clock = new FakeClock();
  assert.equal(contextClock({ io: capture().io, env: {}, clock }), clock);
  assert.notEqual(contextClock({ io: capture().io, env: {} }), undefined);
});

test("withStore uses the context clock, and the system clock without one", async () => {
  const dir = tempDir();
  const env = { PAAS_HOME: dir };
  const clock = new FakeClock(new Date("2026-05-05T05:05:05.000Z"));

  const withFake = await withStore({ io: capture().io, env, clock }, (store) =>
    createApp(store, { name: "fake", image: "nginx:1", port: 80 }),
  );
  assert.equal(withFake.createdAt, clock.now().toISOString());

  const before = Date.now();
  const withSystem = await withStore({ io: capture().io, env }, (store) =>
    createApp(store, { name: "system", image: "nginx:1", port: 80 }),
  );
  const after = Date.now();
  const created = Date.parse(withSystem.createdAt);
  assert.ok(created >= before && created <= after, withSystem.createdAt);
});

test("withEngine passes the shared runtime, clock and store, then closes the store", async () => {
  const dir = tempDir();
  const env = { PAAS_HOME: dir };
  const clock = new FakeClock(new Date("2026-06-06T06:06:06.000Z"));
  const fake = new FakeRuntime({ clock });
  let captured: Store | undefined;

  const app = await withEngine(
    { io: capture().io, env, clock, runtime: () => fake },
    (deps) => {
      assert.equal(deps.runtime, fake);
      assert.equal(deps.clock, clock);
      captured = deps.store;
      return createApp(deps.store, { name: "web", image: "nginx:1", port: 80 });
    },
  );

  assert.equal(app.createdAt, clock.now().toISOString());
  assert.ok(captured, "expected fn to receive a store");
  assert.throws(
    () => captured!.db.exec("SELECT 1"),
    "expected the store to be closed",
  );

  const readBack = await withStore({ io: capture().io, env }, (store) =>
    getApp(store, "web"),
  );
  assert.equal(readBack.name, "web");
});

test("withEngine closes the store when fn throws and propagates the error", async () => {
  const dir = tempDir();
  const env = { PAAS_HOME: dir };
  const fake = new FakeRuntime();
  let captured: Store | undefined;

  await assert.rejects(
    withEngine({ io: capture().io, env, runtime: () => fake }, (deps) => {
      captured = deps.store;
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.ok(captured, "expected fn to receive a store");
  assert.throws(
    () => captured!.db.exec("SELECT 1"),
    "expected the store to be closed",
  );
});

test("withEngine without a runtime rejects before opening the store", async () => {
  const dir = tempDir();
  const socket = join(dir, "missing.sock");
  const env = { PAAS_HOME: dir, PAAS_SOCKET: socket };
  let called = false;

  await assert.rejects(
    withEngine({ io: capture().io, env }, () => {
      called = true;
    }),
    (error: unknown) =>
      error instanceof RuntimeUnavailableError &&
      error.message ===
        `cannot reach container engine at ${socket}: socket not found`,
  );

  assert.equal(called, false, "expected fn not to be called");
  assert.equal(existsSync(join(dir, "state.db")), false);
});

test("withEngine pings an injected runtime before opening the store", async () => {
  const dir = tempDir();
  const fake = new FakeRuntime();
  fake.unavailable = true;
  let called = false;

  await assert.rejects(
    withEngine(
      { io: capture().io, env: { PAAS_HOME: dir }, runtime: () => fake },
      () => {
        called = true;
      },
    ),
    (error: unknown) => error instanceof RuntimeUnavailableError,
  );

  assert.equal(called, false, "expected fn not to be called");
  assert.equal(existsSync(join(dir, "state.db")), false);
});

test("an unreachable engine through run and runAction is a plain operation failure", async () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  const probe: Command = program.command("probe").description("probe the runtime");
  const dir = tempDir();
  const socket = join(dir, "missing.sock");
  probe.action(() =>
    runAction(probe, () =>
      withEngine(
        { io: captureState.io, env: { PAAS_HOME: dir, PAAS_SOCKET: socket } },
        () => {},
      ),
    ),
  );

  const code = await run(["probe"], captureState.io, program);

  assert.equal(code, 1);
  assert.equal(captureState.out, "");
  assert.equal(
    captureState.err,
    `paas: cannot reach container engine at ${socket}: socket not found\n`,
  );
});

test("parseDuration converts each unit to milliseconds", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("1d"), 86_400_000);
});

test("parseDuration rejects malformed values", () => {
  for (const value of ["5x", "m", "1.5h", ""]) {
    assert.throws(
      () => parseDuration(value),
      (error: unknown) =>
        error instanceof UsageError &&
        error.message ===
          `invalid duration "${value}": use a number followed by s, m, h or d`,
    );
  }
});

test("parseTail accepts positive integers and rejects everything else", () => {
  assert.equal(parseTail("1"), 1);
  assert.equal(parseTail("20"), 20);

  for (const value of ["0", "-1", "abc", ""]) {
    assert.throws(
      () => parseTail(value),
      (error: unknown) =>
        error instanceof UsageError &&
        error.message === `invalid tail "${value}"`,
    );
  }
});

test("formatUptime renders each magnitude", () => {
  assert.equal(formatUptime(0), "0s");
  assert.equal(formatUptime(45_999), "45s");
  assert.equal(formatUptime(200_000), "3m 20s");
  assert.equal(formatUptime(7_500_000), "2h 5m");
  assert.equal(formatUptime(356_400_000), "4d 3h");
});

test("shortContainerId cuts to twelve characters and passes null through", () => {
  assert.equal(shortContainerId("abcdef0123456789"), "abcdef012345");
  assert.equal(shortContainerId("abc"), "abc");
  assert.equal(shortContainerId(null), null);
});
