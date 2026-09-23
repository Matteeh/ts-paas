import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { UsageError } from "../src/errors.js";
import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";
import { packageVersion } from "../src/version.js";

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

test("no arguments, --help, and -h print the same help and exit 0", async () => {
  const help = await runCaptured(["--help"]);

  assert.equal(help.code, 0);
  assert.equal(help.err, "");
  assert.ok(help.out.startsWith("Usage: paas"));

  const noArgs = await runCaptured([]);
  assert.deepEqual(noArgs, help);

  const shortHelp = await runCaptured(["-h"]);
  assert.deepEqual(shortHelp, help);
});

test("every registered command has a one-line description that appears in help", () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  program.command("sample").description("do a sample thing");

  const help = program.helpInformation();

  assert.ok(program.commands.length > 0);
  for (const command of program.commands) {
    const description = command.description();
    assert.ok(description.trim().length > 0, "description is non-empty");
    assert.ok(!description.includes("\n"), "description is a single line");
    assert.ok(help.includes(description), "description appears in help");
  }
});

test("--version and -V print the package version and exit 0", async () => {
  for (const args of [["--version"], ["-V"]]) {
    const result = await runCaptured(args);
    assert.equal(result.code, 0);
    assert.equal(result.out, `${packageVersion()}\n`);
    assert.equal(result.err, "");
  }
});

test("an unknown command is a usage error", async () => {
  const result = await runCaptured(["nope"]);

  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.ok(result.err.startsWith("paas: "));
  assert.ok(result.err.includes("Usage: paas"));
});

test("an unknown option is a usage error that mentions the option", async () => {
  const result = await runCaptured(["--bogus"]);

  assert.equal(result.code, 2);
  assert.equal(result.out, "");
  assert.ok(result.err.startsWith("paas: "));
  assert.ok(result.err.includes("--bogus"));
  assert.ok(result.err.includes("Usage: paas"));
});

test("a thrown UsageError is a usage error with the usage text", async () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  program
    .command("boom")
    .description("throw a usage error")
    .action(() => {
      throw new UsageError("bad");
    });

  const code = await run(["boom"], captureState.io, program);

  assert.equal(code, 2);
  assert.equal(captureState.out, "");
  assert.ok(captureState.err.startsWith("paas: bad\n"));
  assert.ok(captureState.err.includes("Usage: paas"));
});

test("a thrown Error is an operation failure that prints only one line", async () => {
  const captureState = capture();
  const program = buildProgram(captureState.io);
  program
    .command("boom")
    .description("throw an error")
    .action(() => {
      throw new Error("boom");
    });

  const code = await run(["boom"], captureState.io, program);

  assert.equal(code, 1);
  assert.equal(captureState.out, "");
  assert.equal(captureState.err, "paas: boom\n");
});

test("cli.ts starts with a shebang and sets process.exitCode from run", () => {
  const source = readFileSync(
    new URL("../src/cli.ts", import.meta.url),
    "utf8",
  );

  assert.ok(source.startsWith("#!/usr/bin/env node\n"));
  assert.match(
    source,
    /process\.exitCode\s*=\s*await run\(process\.argv\.slice\(2\)\)/,
  );
});

test("the cli entry point runs through tsx", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  const version = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--version"],
    { encoding: "utf8" },
  );
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${packageVersion()}\n`);
  assert.equal(version.stderr, "");

  const nope = spawnSync(process.execPath, ["--import", "tsx", cli, "nope"], {
    encoding: "utf8",
  });
  assert.equal(nope.status, 2);
  assert.ok(nope.stderr.startsWith("paas: "));
  assert.equal(nope.stdout, "");
});
