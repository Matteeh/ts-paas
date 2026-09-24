import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { Io } from "../src/output.js";
import { buildProgram, run } from "../src/program.js";

interface PackageJson {
  version: string;
  scripts: Record<string, string>;
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;

test("package.json is 0.1.0 and has the e2e script", () => {
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(
    packageJson.scripts["test:e2e"],
    'node --import tsx --test "tests/e2e/**/*.e2e.ts"',
  );
});

test("paas --version prints 0.1.0 and a newline", async () => {
  let out = "";
  let err = "";
  const io: Io = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  };

  const program = buildProgram(io);
  const code = await run(["--version"], io, program);

  assert.equal(code, 0);
  assert.equal(out, "0.1.0\n");
  assert.equal(err, "");
});
