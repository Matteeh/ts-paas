import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { App } from "../src/state/apps.js";
import { createApp, getApp } from "../src/state/apps.js";
import type { Store } from "../src/state/db.js";
import type { Deployment } from "../src/state/deployments.js";
import { AppExistsError, ValidationError } from "../src/state/errors.js";
import { UsageError } from "../src/errors.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";

import {
  collect,
  formatAppDetails,
  formatTable,
  MASK,
  parseEnvPairs,
  parsePort,
  toAppView,
} from "../src/commands/format.js";
import { runAction, withStore } from "../src/commands/context.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-commands-"));
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

async function runCaptured(
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const captureState = capture();
  const code = await run(argv, captureState.io);
  return { code, out: captureState.out, err: captureState.err };
}

function sampleDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "abc123abc123",
    app: "web",
    image: "nginx:1",
    status: "running",
    containerId: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function sampleApp(overrides: Partial<App> = {}): App {
  return {
    name: "web",
    image: "nginx:1",
    port: 80,
    hostname: null,
    env: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("withStore opens the env's PAAS_HOME, returns the result, and closes the store", async () => {
  const dir = tempDir();
  const env = { PAAS_HOME: dir };
  let captured: Store | undefined;

  const result = await withStore({ io: capture().io, env }, (store) => {
    captured = store;
    return 42;
  });

  assert.equal(result, 42);
  assert.ok(existsSync(join(dir, "state.db")), "expected state.db to be created");
  assert.ok(captured, "expected fn to receive a store");
  assert.throws(() => captured!.db.exec("SELECT 1"), "expected the store to be closed");

  await withStore({ io: capture().io, env }, (store) =>
    createApp(store, { name: "web", image: "nginx:1", port: 80 }),
  );

  const readBack = await withStore({ io: capture().io, env }, (store) =>
    getApp(store, "web"),
  );
  assert.equal(readBack.name, "web");
});

test("withStore closes the store when fn throws and propagates the error", async () => {
  const dir = tempDir();
  let captured: Store | undefined;

  await assert.rejects(
    withStore({ io: capture().io, env: { PAAS_HOME: dir } }, (store) => {
      captured = store;
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.ok(captured, "expected fn to receive a store");
  assert.throws(() => captured!.db.exec("SELECT 1"), "expected the store to be closed");
});

test("a store ValidationError through runAction is a usage error with the command's usage", async () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  const probe = program.command("probe").description("probe the helpers");
  probe.action(() =>
    runAction(probe, () => {
      throw new ValidationError("port", "invalid port 0");
    }),
  );

  const code = await run(["probe"], captureState.io, program);

  assert.equal(code, 2);
  assert.equal(captureState.out, "");
  assert.ok(captureState.err.startsWith("paas: invalid port 0"));
  assert.ok(captureState.err.includes("Usage: paas probe"));
});

test("a thrown UsageError through runAction is a usage error", async () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  const probe = program.command("probe").description("probe the helpers");
  probe.action(() =>
    runAction(probe, () => {
      throw new UsageError("bad flag");
    }),
  );

  const code = await run(["probe"], captureState.io, program);

  assert.equal(code, 2);
  assert.equal(captureState.out, "");
  assert.ok(captureState.err.startsWith("paas: bad flag"));
  assert.ok(captureState.err.includes("Usage: paas probe"));
});

test("another store error through runAction is an operation failure", async () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  const probe = program.command("probe").description("probe the helpers");
  probe.action(() =>
    runAction(probe, () => {
      throw new AppExistsError("web");
    }),
  );

  const code = await run(["probe"], captureState.io, program);

  assert.equal(code, 1);
  assert.equal(captureState.out, "");
  assert.equal(captureState.err, 'paas: app "web" already exists\n');
});

test("toAppView copies the app's fields and takes the status from the latest deployment", () => {
  const app = sampleApp({
    name: "web",
    image: "nginx:1",
    port: 8080,
    hostname: "web.localhost",
    env: { TOKEN: "s3cret" },
  });

  const view = toAppView(app, sampleDeployment({ status: "running" }), {
    reveal: false,
  });

  assert.deepEqual(view, {
    name: "web",
    image: "nginx:1",
    port: 8080,
    hostname: "web.localhost",
    status: "running",
    env: { TOKEN: MASK },
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  });

  const noDeployment = toAppView(app, null, { reveal: true });
  assert.equal(noDeployment.status, null);
  assert.deepEqual(noDeployment.env, { TOKEN: "s3cret" });
});

test("formatAppDetails prints the label lines, sorted env, and dashes for missing values", () => {
  const view = toAppView(
    sampleApp({ env: { B: "2", A: "1" } }),
    null,
    { reveal: true },
  );

  assert.equal(
    formatAppDetails(view),
    [
      "name:    web",
      "image:   nginx:1",
      "port:    80",
      "host:    -",
      "status:  -",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "env:",
      "  A=1",
      "  B=2",
    ].join("\n"),
  );
});

test("formatAppDetails pads an empty env as env:     -", () => {
  const view = toAppView(sampleApp(), null, { reveal: false });

  assert.ok(formatAppDetails(view).endsWith("env:     -"));
});

test("formatTable left-aligns columns separated by two spaces without trailing spaces", () => {
  const table = formatTable(
    ["NAME", "PORT"],
    [
      ["web", "80"],
      ["a", "8080"],
    ],
  );

  assert.equal(table, "NAME  PORT\nweb   80\na     8080");
  for (const line of table.split("\n")) {
    assert.equal(line, line.replace(/ +$/, ""), `trailing spaces on "${line}"`);
  }
});

test("parseEnvPairs splits at the first equals and later values win", () => {
  assert.deepEqual(parseEnvPairs(["A=x=y", "B=", "A=z"]), {
    A: "z",
    B: "",
  });
});

test("parseEnvPairs rejects values without an equals or with an empty key", () => {
  for (const values of [["A"], ["=x"]]) {
    assert.throws(
      () => parseEnvPairs(values),
      (error: unknown) =>
        error instanceof UsageError &&
        error.message === `invalid --env "${values[0]}": expected KEY=VALUE`,
    );
  }
});

test("parsePort accepts digit strings and rejects everything else", () => {
  assert.equal(parsePort("80"), 80);

  for (const value of ["abc", "8.5", ""]) {
    assert.throws(
      () => parsePort(value),
      (error: unknown) =>
        error instanceof UsageError && error.message === `invalid port "${value}"`,
    );
  }
});

test("collect appends to the previous values", () => {
  assert.deepEqual(collect("b", ["a"]), ["a", "b"]);
  assert.deepEqual(collect("a", undefined), ["a"]);
});

test("the shared helpers typecheck through the real program", async () => {
  const result = await runCaptured(["--help"]);
  assert.equal(result.code, 0);
  assert.ok(result.out.includes("Usage: paas"));
});
