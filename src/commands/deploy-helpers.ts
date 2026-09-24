import { UsageError } from "../errors.js";

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a `<number><unit>` duration (`30s`, `5m`, `2h`, `1d`) as milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (match === null) {
    throw new UsageError(
      `invalid duration "${value}": use a number followed by s, m, h or d`,
    );
  }
  return Number(match[1]) * DURATION_UNITS_MS[match[2]!]!;
}

/** Parse a positive integer tail count. */
export function parseTail(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new UsageError(`invalid tail "${value}"`);
  }
  return Number(value);
}

/**
 * Render a running time as `45s`, `3m 20s`, `2h 5m` or `4d 3h`, dropping
 * anything below the largest shown unit.
 */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600) % 24;
  const days = Math.floor(totalSeconds / 86_400);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/** Cut a container id to the first 12 characters; `null` passes through. */
export function shortContainerId(id: string | null): string | null {
  return id === null ? null : id.slice(0, 12);
}
