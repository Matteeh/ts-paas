export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
  sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

interface Sleeper {
  due: number;
  resolve: () => void;
}

export class FakeClock implements Clock {
  private current: number;
  private sleepers: Sleeper[] = [];

  constructor(start: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.sleepers.push({ due: this.current + ms, resolve });
    });
  }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (true) {
      this.sleepers.sort((a, b) => a.due - b.due);
      const next = this.sleepers[0];
      if (next === undefined || next.due > target) {
        break;
      }
      this.sleepers.shift();
      this.current = next.due;
      next.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.current = target;
  }
}
