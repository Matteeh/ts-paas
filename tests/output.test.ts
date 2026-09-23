import assert from "node:assert/strict";
import { test } from "node:test";

import { writeOutput, type Io } from "../src/output.js";

interface Capture {
  io: Io;
  read(): { out: string; err: string };
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
    read: () => ({ ...state }),
  };
}

test("writeOutput in JSON mode writes one JSON line and nothing else", () => {
  const { io, read } = capture();

  writeOutput(io, { a: 1 }, { json: true }, () => "human");

  assert.deepEqual(read(), { out: '{"a":1}\n', err: "" });
});

test("writeOutput in human mode writes the formatter output and nothing else", () => {
  const { io, read } = capture();

  writeOutput(io, { a: 1 }, { json: false }, (value) => `a=${value.a}`);

  assert.deepEqual(read(), { out: "a=1\n", err: "" });
});
