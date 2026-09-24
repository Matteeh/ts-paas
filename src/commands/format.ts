import { UsageError } from "../errors.js";
import type { App } from "../state/apps.js";
import type { Deployment, DeploymentStatus } from "../state/deployments.js";

export const MASK = "******";

export interface AppView {
  name: string;
  image: string;
  port: number;
  hostname: string | null;
  status: DeploymentStatus | null;
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** Project an app and its latest deployment into the shape the commands print. */
export function toAppView(
  app: App,
  latest: Deployment | null,
  options: { reveal: boolean },
): AppView {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(app.env)) {
    env[key] = options.reveal ? value : MASK;
  }

  return {
    name: app.name,
    image: app.image,
    port: app.port,
    hostname: app.hostname,
    status: latest === null ? null : latest.status,
    env,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

function label(name: string, value: string): string {
  return `${name.padEnd(9)}${value}`;
}

/** Render an app as the label-per-line human form. */
export function formatAppDetails(view: AppView): string {
  const lines = [
    label("name:", view.name),
    label("image:", view.image),
    label("port:", String(view.port)),
    label("host:", view.hostname ?? "-"),
    label("status:", view.status ?? "-"),
    label("created:", view.createdAt),
    label("updated:", view.updatedAt),
  ];

  const keys = Object.keys(view.env).sort();
  if (keys.length === 0) {
    lines.push(label("env:", "-"));
  } else {
    lines.push("env:");
    for (const key of keys) {
      lines.push(`  ${key}=${view.env[key]}`);
    }
  }

  return lines.join("\n");
}

/** Render a left-aligned, two-space-separated table with no trailing spaces. */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, index) => {
    let width = header.length;
    for (const row of rows) {
      width = Math.max(width, (row[index] ?? "").length);
    }
    return width;
  });

  const formatRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .replace(/ +$/, "");

  return [formatRow(headers), ...rows.map(formatRow)].join("\n");
}

/** Parse repeatable `KEY=VALUE` options, splitting at the first `=`. */
export function parseEnvPairs(
  values: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) {
      throw new UsageError(
        `invalid --env "${value}": expected KEY=VALUE`,
      );
    }
    env[value.slice(0, index)] = value.slice(index + 1);
  }
  return env;
}

/** Parse a numeric port flag. */
export function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`invalid port "${value}"`);
  }
  return Number(value);
}

/** Commander reducer for repeatable options. */
export function collect(
  value: string,
  previous: string[] | undefined,
): string[] {
  return [...(previous ?? []), value];
}
