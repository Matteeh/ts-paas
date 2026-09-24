import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { demuxDockerLogs, filterLogs } from "../src/runtime/docker-logs.js";
import type { LogEntry } from "../src/runtime/types.js";

const encoder = new TextEncoder();

function frame(stream: 1 | 2 | 0, text: string): Uint8Array {
  const payload = encoder.encode(text);
  const bytes = new Uint8Array(8 + payload.length);
  bytes[0] = stream;
  new DataView(bytes.buffer).setUint32(4, payload.length, false);
  bytes.set(payload, 8);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function truncated(stream: 1 | 2, claimedLength: number, payload: string): Uint8Array {
  const body = encoder.encode(payload);
  const bytes = new Uint8Array(8 + body.length);
  bytes[0] = stream;
  new DataView(bytes.buffer).setUint32(4, claimedLength, false);
  bytes.set(body, 8);
  return bytes;
}

const T1 = new Date("2026-01-01T00:00:00.123Z");
const T2 = new Date("2026-01-01T00:00:01.000Z");

describe("demuxDockerLogs", () => {
  it("splits a stdout and a stderr frame by header", () => {
    const data = concat(
      frame(1, "2026-01-01T00:00:00.123456789Z a\n"),
      frame(2, "2026-01-01T00:00:01.000000000Z b\n"),
    );
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: false }), [
      { stream: "stdout", time: T1, text: "a" },
      { stream: "stderr", time: T2, text: "b" },
    ]);
  });

  it("treats stream byte 0 as stdout", () => {
    const data = frame(0, "2026-01-01T00:00:00.123Z a\n");
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: false }), [
      { stream: "stdout", time: T1, text: "a" },
    ]);
  });

  it("joins a line split across two frames of the same stream", () => {
    const data = concat(
      frame(1, "2026-01-01T00:00:00.123Z hel"),
      frame(1, "lo\n"),
    );
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: false }), [
      { stream: "stdout", time: T1, text: "hello" },
    ]);
  });

  it("returns one entry per line when a frame holds two lines", () => {
    const data = frame(
      1,
      "2026-01-01T00:00:00.123Z first\n2026-01-01T00:00:01.000Z second\n",
    );
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: false }), [
      { stream: "stdout", time: T1, text: "first" },
      { stream: "stdout", time: T2, text: "second" },
    ]);
  });

  it("returns a trailing partial line without a newline", () => {
    const data = frame(1, "2026-01-01T00:00:00.123Z tail");
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: false }), [
      { stream: "stdout", time: T1, text: "tail" },
    ]);
  });

  it("ignores a truncated final frame without throwing", () => {
    const data = concat(
      frame(1, "2026-01-01T00:00:00.123Z kept\n"),
      truncated(1, 100, "2026-01-01T00:00:01.000Z dropped\n"),
    );
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: false }), [
      { stream: "stdout", time: T1, text: "kept" },
    ]);
  });

  it("returns nothing for a buffer that is only a truncated frame", () => {
    const data = truncated(1, 50, "partial");
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: false }), []);
  });

  it("sorts entries by time, stably", () => {
    const data = concat(
      frame(2, "2026-01-01T00:00:01.000Z later\n"),
      frame(1, "2026-01-01T00:00:00.123Z earlier\n"),
    );
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: false }), [
      { stream: "stdout", time: T1, text: "earlier" },
      { stream: "stderr", time: T2, text: "later" },
    ]);
  });

  it("keeps insertion order for equal times", () => {
    const data = concat(
      frame(1, "2026-01-01T00:00:00.123Z first\n"),
      frame(2, "2026-01-01T00:00:00.123Z second\n"),
    );
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: false }), [
      { stream: "stdout", time: T1, text: "first" },
      { stream: "stderr", time: T1, text: "second" },
    ]);
  });

  it("reads a headerless TTY buffer as stdout lines", () => {
    const data = encoder.encode(
      "2026-01-01T00:00:00.123Z a\n2026-01-01T00:00:01.000Z b\n",
    );
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: true }), [
      { stream: "stdout", time: T1, text: "a" },
      { stream: "stdout", time: T2, text: "b" },
    ]);
  });

  it("returns a trailing TTY line without a newline", () => {
    const data = encoder.encode("2026-01-01T00:00:00.123Z only");
    assert.deepStrictEqual(demuxDockerLogs(data, { tty: true }), [
      { stream: "stdout", time: T1, text: "only" },
    ]);
  });
});

function entry(
  stream: "stdout" | "stderr",
  time: Date,
  text: string,
): LogEntry {
  return { stream, time, text };
}

describe("filterLogs", () => {
  const entries = [
    entry("stdout", new Date("2026-01-01T00:00:00.000Z"), "a"),
    entry("stdout", new Date("2026-01-01T00:00:01.000Z"), "b"),
    entry("stdout", new Date("2026-01-01T00:00:02.000Z"), "c"),
  ];

  it("returns every entry when given neither since nor tail", () => {
    assert.deepStrictEqual(filterLogs(entries, {}), entries);
  });

  it("keeps entries at or after since to the millisecond", () => {
    assert.deepStrictEqual(
      filterLogs(entries, { since: new Date("2026-01-01T00:00:01.000Z") }),
      entries.slice(1),
    );
    assert.deepStrictEqual(
      filterLogs(entries, { since: new Date("2026-01-01T00:00:01.001Z") }),
      entries.slice(2),
    );
  });

  it("keeps the last tail entries after applying since", () => {
    assert.deepStrictEqual(
      filterLogs(entries, {
        since: new Date("2026-01-01T00:00:01.000Z"),
        tail: 1,
      }),
      entries.slice(2),
    );
  });

  it("returns none for tail 0", () => {
    assert.deepStrictEqual(filterLogs(entries, { tail: 0 }), []);
  });

  it("returns every entry when tail exceeds the count", () => {
    assert.deepStrictEqual(filterLogs(entries, { tail: 10 }), entries);
  });
});
