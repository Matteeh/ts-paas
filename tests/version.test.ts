import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { packageVersion } from "../src/version.js";

test("packageVersion returns the version in package.json", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  assert.equal(packageVersion(), packageJson.version);
});
