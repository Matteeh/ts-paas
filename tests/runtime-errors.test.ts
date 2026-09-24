import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContainerNotFoundError,
  ImageNotFoundError,
  NameConflictError,
  RuntimeError,
  RuntimeUnavailableError,
} from "../src/runtime/errors.js";
import { MANAGED_LABEL } from "../src/runtime/types.js";

type ErrorConstructor = new (
  message: string,
  options?: { cause?: unknown },
) => RuntimeError;

const cases: Array<[ErrorConstructor, string]> = [
  [ImageNotFoundError, "ImageNotFoundError"],
  [ContainerNotFoundError, "ContainerNotFoundError"],
  [NameConflictError, "NameConflictError"],
  [RuntimeUnavailableError, "RuntimeUnavailableError"],
];

test("each runtime error subclass is a RuntimeError and an Error", () => {
  for (const [ErrorClass] of cases) {
    const error = new ErrorClass("boom");
    assert.ok(error instanceof RuntimeError);
    assert.ok(error instanceof Error);
  }
});

test("each runtime error subclass keeps its class name", () => {
  for (const [ErrorClass, name] of cases) {
    const error = new ErrorClass("boom");
    assert.equal(error.name, name);
  }
});

test("each runtime error keeps its message", () => {
  for (const [ErrorClass] of cases) {
    const error = new ErrorClass("something failed");
    assert.equal(error.message, "something failed");
  }
});

test("each runtime error keeps the given cause", () => {
  const cause = new Error("underlying");
  for (const [ErrorClass] of cases) {
    const error = new ErrorClass("something failed", { cause });
    assert.equal(error.cause, cause);
  }
});

test("RuntimeError itself keeps its name, message and cause", () => {
  const cause = new Error("underlying");
  const error = new RuntimeError("something failed", { cause });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "RuntimeError");
  assert.equal(error.message, "something failed");
  assert.equal(error.cause, cause);
});

test("MANAGED_LABEL is paas.managed", () => {
  assert.equal(MANAGED_LABEL, "paas.managed");
});
