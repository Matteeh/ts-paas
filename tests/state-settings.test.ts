import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { MIGRATIONS, openStore, schemaVersion } from "../src/state/db.js";
import { ValidationError } from "../src/state/errors.js";
import {
  DEFAULT_INGRESS_SETTINGS,
  getIngressSettings,
  setIngressSettings,
} from "../src/state/settings.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-settings-"));
  tempDirs.push(dir);
  return join(dir, "state.db");
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function expectValidation(field: string, message: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ValidationError, `${field}: expected ValidationError`);
    assert.equal(error.field, field);
    assert.equal(error.message, message);
    return true;
  });
}

test("a new store exposes the default ingress settings", () => {
  const store = openStore(":memory:");
  try {
    assert.deepEqual(DEFAULT_INGRESS_SETTINGS, {
      tls: "off",
      httpPort: 80,
      httpsPort: 443,
    });
    assert.deepEqual(getIngressSettings(store), {
      tls: "off",
      httpPort: 80,
      httpsPort: 443,
    });
    assert.equal(MIGRATIONS.length, 2);
    assert.equal(schemaVersion(store), MIGRATIONS.length);
    const table = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
      .get();
    assert.ok(table, "expected the settings table to exist");
  } finally {
    store.close();
  }
});

test("setting only the http port merges with defaults and survives reopening", () => {
  const path = tempDbPath();

  const first = openStore(path);
  try {
    assert.deepEqual(setIngressSettings(first, { httpPort: 8080 }), {
      tls: "off",
      httpPort: 8080,
      httpsPort: 443,
    });
  } finally {
    first.close();
  }

  const second = openStore(path);
  try {
    assert.deepEqual(getIngressSettings(second), {
      tls: "off",
      httpPort: 8080,
      httpsPort: 443,
    });
  } finally {
    second.close();
  }
});

test("setting the tls mode keeps previously stored ports", () => {
  const store = openStore(":memory:");
  try {
    setIngressSettings(store, { httpPort: 8080 });
    assert.deepEqual(setIngressSettings(store, { tls: "auto" }), {
      tls: "auto",
      httpPort: 8080,
      httpsPort: 443,
    });
    assert.deepEqual(getIngressSettings(store), {
      tls: "auto",
      httpPort: 8080,
      httpsPort: 443,
    });
  } finally {
    store.close();
  }
});

test("invalid values fail with their field and store nothing", () => {
  const store = openStore(":memory:");
  try {
    expectValidation("tls", 'invalid TLS mode "on": use off or auto', () =>
      setIngressSettings(store, { tls: "on" as never }),
    );
    expectValidation("httpPort", "invalid http port 0", () =>
      setIngressSettings(store, { httpPort: 0 }),
    );
    expectValidation("httpsPort", "invalid https port 70000", () =>
      setIngressSettings(store, { httpsPort: 70000 }),
    );

    assert.deepEqual(getIngressSettings(store), {
      tls: "off",
      httpPort: 80,
      httpsPort: 443,
    });
    const rows = store.db.prepare("SELECT key FROM settings").all();
    assert.equal(rows.length, 0);
  } finally {
    store.close();
  }
});

test("equal merged ports are refused naming httpsPort", () => {
  const store = openStore(":memory:");
  try {
    setIngressSettings(store, { httpPort: 8080 });

    expectValidation(
      "httpsPort",
      "https port 8080 is also the http port",
      () => setIngressSettings(store, { httpsPort: 8080 }),
    );

    assert.deepEqual(getIngressSettings(store), {
      tls: "off",
      httpPort: 8080,
      httpsPort: 443,
    });

    assert.deepEqual(setIngressSettings(store, { httpPort: 443, httpsPort: 80 }), {
      tls: "off",
      httpPort: 443,
      httpsPort: 80,
    });
  } finally {
    store.close();
  }
});
