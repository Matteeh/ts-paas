import assert from "node:assert/strict";
import { test } from "node:test";

import { ValidationError } from "../src/state/errors.js";
import {
  validateAppName,
  validateEnv,
  validateHostname,
  validateImage,
  validatePort,
} from "../src/state/validate.js";

function expectValidation(field: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ValidationError, `${field}: expected ValidationError`);
    assert.equal(error.field, field);
    return true;
  });
}

const forty = "a" + "b".repeat(39);
const fortyOne = "a" + "b".repeat(40);
const label64 = "a".repeat(64) + ".com";
const name254 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`;

test("validateAppName accepts a, web-1 and a 40-character name", () => {
  for (const name of ["a", "web-1", forty]) {
    assert.equal(validateAppName(name), name);
  }
});

test("validateAppName rejects invalid names naming the field", () => {
  for (const name of ["", "Web", "1web", "-web", "web_1", fortyOne]) {
    expectValidation("name", () => validateAppName(name));
  }
});

test("validateImage accepts image references without whitespace", () => {
  for (const image of ["nginx:1", "ghcr.io/a/b@sha256:abc"]) {
    assert.equal(validateImage(image), image);
  }
});

test("validateImage rejects empty and whitespace names naming the field", () => {
  for (const image of ["", "a b"]) {
    expectValidation("image", () => validateImage(image));
  }
});

test("validatePort accepts 1 and 65535", () => {
  assert.equal(validatePort(1), 1);
  assert.equal(validatePort(65535), 65535);
});

test("validatePort rejects out-of-range and non-integers naming the field", () => {
  for (const port of [0, 65536, 80.5]) {
    expectValidation("port", () => validatePort(port));
  }
});

test("validateEnv accepts identifier keys and any string value", () => {
  assert.deepEqual(validateEnv({ A_1: "x", _b: "" }), { A_1: "x", _b: "" });
});

test("validateEnv rejects invalid keys naming the field", () => {
  const cases: Record<string, string>[] = [
    { "1A": "x" },
    { "A-B": "x" },
    { "": "x" },
  ];
  for (const bad of cases) {
    expectValidation("env", () => validateEnv(bad));
  }
});

test("validateHostname lowercases and accepts valid DNS names", () => {
  assert.equal(validateHostname("Whoami.Localhost"), "whoami.localhost");
  assert.equal(validateHostname("a-b.example.com"), "a-b.example.com");
});

test("validateHostname rejects invalid names naming the field", () => {
  for (const hostname of [
    "",
    "-a.com",
    "a-.com",
    "a..com",
    "a.com.",
    "a_b.com",
    label64,
    name254,
  ]) {
    expectValidation("hostname", () => validateHostname(hostname));
  }
});
