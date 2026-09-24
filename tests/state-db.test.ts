import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { FakeClock } from "../src/clock.js";
import { MIGRATIONS, openStore, schemaVersion } from "../src/state/db.js";
import {
  AppExistsError,
  AppNotFoundError,
  AppRunningError,
  DeploymentFinishedError,
  DeploymentNotFoundError,
  HostnameInUseError,
  SchemaTooNewError,
  StateError,
  ValidationError,
} from "../src/state/errors.js";
import { paasHome, stateDbPath } from "../src/state/paths.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-state-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paasHome prefers a non-empty PAAS_HOME", () => {
  assert.equal(paasHome({ PAAS_HOME: "/tmp/p" }), "/tmp/p");
});

test("paasHome falls back to ~/.paas when PAAS_HOME is unset or empty", () => {
  const fallback = join(homedir(), ".paas");
  assert.equal(paasHome({}), fallback);
  assert.equal(paasHome({ PAAS_HOME: "" }), fallback);
});

test("stateDbPath appends state.db", () => {
  assert.equal(stateDbPath({ PAAS_HOME: "/tmp/p" }), join("/tmp/p", "state.db"));
});

test("openStore applies MIGRATIONS and creates the schema tables", () => {
  const store = openStore(":memory:");
  try {
    assert.equal(schemaVersion(store), MIGRATIONS.length);
    assert.ok(MIGRATIONS.length >= 1);
    for (const table of ["apps", "deployments", "deployment_events"]) {
      const row = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      assert.ok(row, `expected table ${table} to exist`);
    }
  } finally {
    store.close();
  }
});

test("default newId returns 12 lowercase hex characters", () => {
  const store = openStore(":memory:");
  try {
    assert.match(store.newId(), /^[0-9a-f]{12}$/);
  } finally {
    store.close();
  }
});

test("opening a file path creates parents and applies each migration once", () => {
  const path = join(tempDir(), "nested", "deeper", "state.db");
  const clock = new FakeClock(new Date("2026-01-01T00:00:00.000Z"));

  const first = openStore(path, { clock });
  assert.equal(schemaVersion(first), MIGRATIONS.length);
  first.close();

  assert.ok(existsSync(path), "expected the database file to exist");

  const second = openStore(path, { clock });
  try {
    const rows = second.db
      .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
      .all();
    assert.equal(rows.length, MIGRATIONS.length);
    for (let i = 0; i < MIGRATIONS.length; i++) {
      assert.equal(rows[i].version, i + 1);
      assert.equal(rows[i].applied_at, "2026-01-01T00:00:00.000Z");
    }
  } finally {
    second.close();
  }
});

test("a failed migration rolls back and records no version", () => {
  const path = join(tempDir(), "state.db");

  assert.throws(() =>
    openStore(path, {
      migrations: ["CREATE TABLE a(x)", "CREATE TABLE b(y); SELECT * FROM nope"],
    }),
  );

  const db = new DatabaseSync(path);
  try {
    const a = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'a'")
      .get();
    assert.ok(a, "expected table a to exist");
    const b = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'b'")
      .get();
    assert.equal(b, undefined, "expected table b not to exist");
    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version);
    assert.deepEqual(versions, [1]);
  } finally {
    db.close();
  }
});

test("opening a newer database throws SchemaTooNewError", () => {
  const path = join(tempDir(), "state.db");
  const store = openStore(path);
  store.db
    .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(99, "2026-01-01T00:00:00.000Z");
  store.close();

  assert.throws(
    () => openStore(path),
    (error: unknown) => {
      assert.ok(error instanceof SchemaTooNewError);
      assert.equal(error.found, 99);
      assert.equal(error.supported, MIGRATIONS.length);
      assert.equal(
        error.message,
        `state database schema version 99 is newer than this paas supports (${MIGRATIONS.length}); upgrade paas`,
      );
      return true;
    },
  );
});

test("each store error is a StateError with its class name and message", () => {
  const cases: Array<[StateError, string, string]> = [
    [new AppNotFoundError("web"), "AppNotFoundError", 'app "web" not found'],
    [new AppExistsError("web"), "AppExistsError", 'app "web" already exists'],
    [
      new HostnameInUseError("x.localhost", "web"),
      "HostnameInUseError",
      'hostname "x.localhost" is already used by app "web"',
    ],
    [
      new AppRunningError("web"),
      "AppRunningError",
      'app "web" has a running deployment; stop the app first',
    ],
    [
      new DeploymentNotFoundError("abc"),
      "DeploymentNotFoundError",
      'deployment "abc" not found',
    ],
    [
      new DeploymentFinishedError("abc", "failed"),
      "DeploymentFinishedError",
      'deployment "abc" is already failed',
    ],
    [
      new SchemaTooNewError(99, 1),
      "SchemaTooNewError",
      "state database schema version 99 is newer than this paas supports (1); upgrade paas",
    ],
  ];

  for (const [error, name, message] of cases) {
    assert.ok(error instanceof StateError, `${name} should be a StateError`);
    assert.ok(error instanceof Error, `${name} should be an Error`);
    assert.equal(error.name, name);
    assert.equal(error.message, message);
  }
});

test("ValidationError keeps its field", () => {
  const error = new ValidationError("name", "invalid name");
  assert.ok(error instanceof StateError);
  assert.equal(error.name, "ValidationError");
  assert.equal(error.field, "name");
  assert.equal(error.message, "invalid name");
});

test("opening and closing in a child process writes nothing to stderr", () => {
  const path = join(tempDir(), "state.db");
  const moduleUrl = pathToFileURL(resolve("src/state/db.ts")).href;
  const script = [
    `import { openStore } from ${JSON.stringify(moduleUrl)};`,
    `const store = openStore(${JSON.stringify(path)});`,
    "store.close();",
  ].join("\n");

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, `child exited with ${result.status}: ${result.stderr}`);
  assert.equal(result.stderr, "");
});
