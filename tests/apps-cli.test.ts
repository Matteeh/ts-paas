import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { getApp } from "../src/state/apps.js";
import { openStore } from "../src/state/db.js";
import { createDeployment, setDeploymentStatus } from "../src/state/deployments.js";
import { stateDbPath } from "../src/state/paths.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paas-apps-cli-"));
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

async function runIn(dir: string, argv: readonly string[]): Promise<CommandResult> {
  const captureState = capture();
  const program = buildProgram(captureState.io, {
    env: { PAAS_HOME: dir },
  });
  const code = await run(argv, captureState.io, program);
  return { code, out: captureState.out, err: captureState.err };
}

function readApp(dir: string, name: string) {
  const store = openStore(stateDbPath({ PAAS_HOME: dir }));
  try {
    return getApp(store, name);
  } finally {
    store.close();
  }
}

function seedRunning(dir: string, app: string): void {
  const store = openStore(stateDbPath({ PAAS_HOME: dir }));
  try {
    const deployment = createDeployment(store, { app, image: "nginx" });
    setDeploymentStatus(store, deployment.id, "running");
  } finally {
    store.close();
  }
}

test("paas apps alone prints its help to stderr and exits 2", async () => {
  const result = await runIn(tempDir(), ["apps"]);

  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.ok(result.err.includes("Usage: paas apps"), result.err);
  for (const name of ["create", "list", "show", "set", "delete"]) {
    assert.ok(result.err.includes(name), `expected ${name} in help`);
  }
});

test("paas apps --help lists each subcommand with its description", async () => {
  const result = await runIn(tempDir(), ["apps", "--help"]);

  assert.equal(result.code, 0);
  assert.equal(result.err, "");
  assert.ok(result.out.includes("Usage: paas apps"));
  for (const [name, description] of [
    ["create", "create an app"],
    ["list", "list apps"],
    ["show", "show one app"],
    ["set", "change an app"],
    ["delete", "delete an app"],
  ]) {
    assert.ok(result.out.includes(name), `expected ${name}`);
    assert.ok(result.out.includes(description), `expected ${description}`);
  }
});

test("a child process runs apps list through tsx and creates state.db", () => {
  const dir = tempDir();
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "apps", "list"],
    { encoding: "utf8", env: { ...process.env, PAAS_HOME: dir } },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "no apps\n");
  assert.equal(result.stderr, "");
  assert.ok(existsSync(join(dir, "state.db")), "expected state.db");
});

test("create stores the app and prints masked details", async () => {
  const dir = tempDir();
  const result = await runIn(dir, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
    "--host",
    "Web.Localhost",
    "--env",
    "A=x=y",
    "--env",
    "A=z",
  ]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.ok(result.out.includes("  A=******"), result.out);
  assert.ok(result.out.includes("host:    web.localhost"), result.out);

  const app = readApp(dir, "web");
  assert.equal(app.hostname, "web.localhost");
  assert.deepEqual(app.env, { A: "z" });
});

test("create --json prints the masked AppView on one line", async () => {
  const dir = tempDir();
  const result = await runIn(dir, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
    "--env",
    "TOKEN=s3cret",
    "--json",
  ]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.ok(!result.out.includes("s3cret"));
  assert.equal(result.out.trimEnd().split("\n").length, 1);

  const view = JSON.parse(result.out) as Record<string, unknown>;
  assert.equal(view.name, "web");
  assert.equal(view.image, "nginx:1");
  assert.equal(view.port, 80);
  assert.equal(view.hostname, null);
  assert.equal(view.status, null);
  assert.deepEqual(view.env, { TOKEN: "******" });
  assert.equal(typeof view.createdAt, "string");
  assert.equal(typeof view.updatedAt, "string");
});

test("create refuses an existing name as an operation failure", async () => {
  const dir = tempDir();
  await runIn(dir, ["apps", "create", "web", "--image", "nginx:1", "--port", "80"]);

  const result = await runIn(dir, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "80",
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.equal(result.err, 'paas: app "web" already exists\n');
});

test("create without --image is a usage error", async () => {
  const result = await runIn(tempDir(), ["apps", "create", "web", "--port", "80"]);

  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.ok(result.err.startsWith("paas: "), result.err);
  assert.ok(result.err.includes("--image"), result.err);
});

test("validation failures are usage errors that store nothing", async () => {
  const cases: [string[], string][] = [
    [
      ["apps", "create", "web", "--image", "nginx:1", "--port", "0"],
      "paas: invalid port 0",
    ],
    [
      ["apps", "create", "web", "--image", "nginx:1", "--port", "abc"],
      'paas: invalid port "abc"',
    ],
    [
      ["apps", "create", "web", "--image", "nginx:1", "--port", "80", "--env", "NOEQ"],
      'paas: invalid --env "NOEQ": expected KEY=VALUE',
    ],
    [
      ["apps", "create", "Web", "--image", "nginx:1", "--port", "80"],
      'paas: invalid app name "Web"',
    ],
  ];

  for (const [argv, message] of cases) {
    const dir = tempDir();
    const result = await runIn(dir, argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.equal(result.out, "", argv.join(" "));
    assert.ok(result.err.startsWith(message), `${argv.join(" ")}: ${result.err}`);

    const list = await runIn(dir, ["apps", "list"]);
    assert.equal(list.out, "no apps\n", `stored something for ${argv.join(" ")}`);
  }
});

test("the invalid port usage error carries the command's usage", async () => {
  const result = await runIn(tempDir(), [
    "apps",
    "create",
    "web",
    "--image",
    "nginx:1",
    "--port",
    "0",
  ]);

  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.ok(result.err.startsWith("paas: invalid port 0"), result.err);
  assert.ok(result.err.includes("Usage: paas apps create"), result.err);
});

test("list prints no apps and [] when there are none", async () => {
  const dir = tempDir();

  const human = await runIn(dir, ["apps", "list"]);
  assert.equal(human.code, 0);
  assert.equal(human.err, "");
  assert.equal(human.out, "no apps\n");

  const json = await runIn(dir, ["apps", "list", "--json"]);
  assert.equal(json.code, 0);
  assert.equal(json.err, "");
  assert.equal(json.out, "[]\n");
});

test("list prints an aligned table ordered by name with dashes for missing values", async () => {
  const dir = tempDir();
  await runIn(dir, ["apps", "create", "web", "--image", "nginx", "--port", "80"]);
  await runIn(dir, ["apps", "create", "api", "--image", "redis", "--port", "6379"]);
  seedRunning(dir, "web");

  const result = await runIn(dir, ["apps", "list"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  const lines = result.out.trimEnd().split("\n");
  assert.equal(lines[0], "NAME  IMAGE  PORT  HOST  STATUS");
  assert.equal(lines.length, 3);
  assert.ok(lines[1]!.startsWith("api"), lines[1]);
  assert.ok(lines[2]!.startsWith("web"), lines[2]);
  assert.ok(lines[1]!.includes("-"), lines[1]);
  assert.ok(lines[2]!.includes("running"), lines[2]);
  for (const line of lines) {
    assert.equal(line, line.replace(/ +$/, ""), `trailing spaces on "${line}"`);
  }
});

test("list --json prints app objects without env", async () => {
  const dir = tempDir();
  await runIn(dir, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx",
    "--port",
    "80",
    "--env",
    "A=1",
  ]);
  await runIn(dir, ["apps", "create", "api", "--image", "redis", "--port", "6379"]);
  seedRunning(dir, "web");

  const result = await runIn(dir, ["apps", "list", "--json"]);

  assert.equal(result.code, 0, result.err);
  const rows = JSON.parse(result.out) as Record<string, unknown>[];
  assert.deepEqual(
    rows.map((row) => row.name),
    ["api", "web"],
  );
  assert.deepEqual(Object.keys(rows[0]!).sort(), [
    "createdAt",
    "hostname",
    "image",
    "name",
    "port",
    "status",
    "updatedAt",
  ]);
  assert.equal(rows[0]!.status, null);
  assert.equal(rows[1]!.status, "running");
  assert.equal("env" in rows[0]!, false);
});

test("show masks env by default and reveals it with --reveal", async () => {
  const dir = tempDir();
  await runIn(dir, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx",
    "--port",
    "80",
    "--env",
    "TOKEN=s3cret",
  ]);

  const masked = await runIn(dir, ["apps", "show", "web"]);
  assert.equal(masked.code, 0, masked.err);
  assert.ok(!masked.out.includes("s3cret"));
  assert.ok(masked.out.includes("  TOKEN=******"), masked.out);

  const maskedJson = await runIn(dir, ["apps", "show", "web", "--json"]);
  assert.ok(!maskedJson.out.includes("s3cret"));
  assert.deepEqual(JSON.parse(maskedJson.out).env, { TOKEN: "******" });

  const revealed = await runIn(dir, ["apps", "show", "web", "--reveal"]);
  assert.ok(revealed.out.includes("  TOKEN=s3cret"), revealed.out);

  const revealedJson = await runIn(dir, ["apps", "show", "web", "--json", "--reveal"]);
  assert.deepEqual(JSON.parse(revealedJson.out).env, { TOKEN: "s3cret" });
});

test("show of an unknown app is an operation failure", async () => {
  const result = await runIn(tempDir(), ["apps", "show", "nope"]);

  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.equal(result.err, 'paas: app "nope" not found\n');
});

test("set merges env, replacing and unsetting keys", async () => {
  const dir = tempDir();
  await runIn(dir, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx",
    "--port",
    "80",
    "--env",
    "A=1",
    "--env",
    "B=2",
  ]);

  const result = await runIn(dir, [
    "apps",
    "set",
    "web",
    "--env",
    "B=3",
    "--env",
    "C=4",
    "--unset-env",
    "A",
  ]);

  assert.equal(result.code, 0, result.err);
  assert.deepEqual(readApp(dir, "web").env, { B: "3", C: "4" });
});

test("set --port changes only the port", async () => {
  const dir = tempDir();
  await runIn(dir, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx",
    "--port",
    "80",
    "--env",
    "A=1",
  ]);

  const result = await runIn(dir, ["apps", "set", "web", "--port", "81"]);

  assert.equal(result.code, 0, result.err);
  const app = readApp(dir, "web");
  assert.equal(app.port, 81);
  assert.equal(app.image, "nginx");
  assert.deepEqual(app.env, { A: "1" });
});

test("set --unset-host clears the host", async () => {
  const dir = tempDir();
  await runIn(dir, [
    "apps",
    "create",
    "web",
    "--image",
    "nginx",
    "--port",
    "80",
    "--host",
    "web.localhost",
  ]);

  const result = await runIn(dir, ["apps", "set", "web", "--unset-host"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(readApp(dir, "web").hostname, null);
});

test("set rejects nothing to change, host conflicts and env conflicts", async () => {
  const dir = tempDir();
  await runIn(dir, ["apps", "create", "web", "--image", "nginx", "--port", "80"]);

  const cases: [string[], string][] = [
    [["apps", "set", "web"], "paas: nothing to change"],
    [
      ["apps", "set", "web", "--host", "x.localhost", "--unset-host"],
      "paas: --host and --unset-host conflict",
    ],
    [
      ["apps", "set", "web", "--env", "A=1", "--unset-env", "A"],
      "paas: A is both set and unset",
    ],
  ];

  for (const [argv, message] of cases) {
    const result = await runIn(dir, argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.equal(result.out, "", argv.join(" "));
    assert.ok(
      result.err.startsWith(message),
      `${argv.join(" ")}: ${result.err}`,
    );
  }
});

test("set to a host used by another app is an operation failure", async () => {
  const dir = tempDir();
  await runIn(dir, [
    "apps",
    "create",
    "a",
    "--image",
    "nginx",
    "--port",
    "80",
    "--host",
    "x.localhost",
  ]);
  await runIn(dir, ["apps", "create", "b", "--image", "nginx", "--port", "81"]);

  const result = await runIn(dir, ["apps", "set", "b", "--host", "x.localhost"]);

  assert.equal(result.code, 1);
  assert.equal(
    result.err,
    'paas: hostname "x.localhost" is already used by app "a"\n',
  );
});

test("delete removes the app and prints its name", async () => {
  const dir = tempDir();
  await runIn(dir, ["apps", "create", "web", "--image", "nginx", "--port", "80"]);

  const result = await runIn(dir, ["apps", "delete", "web"]);

  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, "");
  assert.equal(result.out, "deleted app web\n");

  const list = await runIn(dir, ["apps", "list"]);
  assert.equal(list.out, "no apps\n");
});

test("delete refuses an app with a running deployment", async () => {
  const dir = tempDir();
  await runIn(dir, ["apps", "create", "web", "--image", "nginx", "--port", "80"]);
  seedRunning(dir, "web");

  const result = await runIn(dir, ["apps", "delete", "web"]);

  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.equal(
    result.err,
    'paas: app "web" has a running deployment; stop the app first\n',
  );

  const list = await runIn(dir, ["apps", "list"]);
  assert.ok(list.out.includes("web"), "expected web to still exist");
});
