import assert from "node:assert/strict";
import { test } from "node:test";

import { FakeClock, systemClock } from "../src/clock.js";

test("systemClock.now is within 1s of Date.now", () => {
  const before = Date.now();
  const now = systemClock.now();
  const after = Date.now();
  assert.ok(now instanceof Date);
  assert.ok(now.getTime() >= before - 1000);
  assert.ok(now.getTime() <= after + 1000);
});

test("systemClock.sleep waits at least the requested real time", async () => {
  const before = Date.now();
  await systemClock.sleep(5);
  const elapsed = Date.now() - before;
  assert.ok(elapsed >= 5, `expected at least 5ms, got ${elapsed}ms`);
});

test("FakeClock defaults to 2026-01-01T00:00:00.000Z", () => {
  const clock = new FakeClock();
  assert.equal(clock.now().toISOString(), "2026-01-01T00:00:00.000Z");
});

test("FakeClock honors an explicit start date", () => {
  const start = new Date("2030-05-06T07:08:09.123Z");
  const clock = new FakeClock(start);
  assert.equal(clock.now().getTime(), start.getTime());
});

test("FakeClock stands still with no advance, even after real time passes", async () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const clock = new FakeClock(start);
  const before = clock.now().getTime();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(clock.now().getTime(), before);
});

test("moving a Date returned by FakeClock does not change the clock", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const clock = new FakeClock(start);
  const returned = clock.now();
  returned.setTime(0);
  assert.equal(clock.now().getTime(), start.getTime());
});

test("FakeClock does not resolve a sleep until advance reaches its due time", async () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const clock = new FakeClock(start);
  let resolved = false;
  const pending = clock.sleep(3000).then(() => {
    resolved = true;
  });

  await clock.advance(2999);
  assert.equal(resolved, false);
  assert.equal(clock.now().getTime(), start.getTime() + 2999);

  await clock.advance(1);
  assert.equal(resolved, true);
  assert.equal(clock.now().getTime(), start.getTime() + 3000);

  await pending;
});

test("FakeClock sleep(0) resolves without advance", async () => {
  const clock = new FakeClock();
  await clock.sleep(0);
  assert.equal(clock.now().toISOString(), "2026-01-01T00:00:00.000Z");
});

test("FakeClock resolves sleeps in due order and settles after chained work", async () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const clock = new FakeClock(start);
  const order: string[] = [];
  const seenTimes: number[] = [];

  const first = clock.sleep(200).then(() => {
    order.push("200");
    seenTimes.push(clock.now().getTime());
  });
  const second = clock.sleep(100).then(() => {
    order.push("100");
    seenTimes.push(clock.now().getTime());
  });

  await clock.advance(500);

  assert.deepEqual(order, ["100", "200"]);
  assert.deepEqual(seenTimes, [start.getTime() + 100, start.getTime() + 200]);
  assert.equal(clock.now().getTime(), start.getTime() + 500);

  await Promise.all([first, second]);
});

test("FakeClock resolves sleepers chained during advance", async () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const clock = new FakeClock(start);
  const order: string[] = [];

  const outer = clock.sleep(100).then(async () => {
    order.push("first");
    await clock.sleep(150);
    order.push("second");
  });

  await clock.advance(250);
  await outer;

  assert.deepEqual(order, ["first", "second"]);
  assert.equal(clock.now().getTime(), start.getTime() + 250);
});
