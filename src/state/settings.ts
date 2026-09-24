import type { Store } from "./db.js";
import { ValidationError } from "./errors.js";
import { validatePort } from "./validate.js";

/** The two TLS modes ingress understands. */
export type TlsMode = "off" | "auto";

export interface IngressSettings {
  tls: TlsMode;
  httpPort: number;
  httpsPort: number;
}

/** What ingress uses when nothing has been stored yet. */
export const DEFAULT_INGRESS_SETTINGS: IngressSettings = {
  tls: "off",
  httpPort: 80,
  httpsPort: 443,
};

const TLS_KEY = "ingress.tls";
const HTTP_PORT_KEY = "ingress.http_port";
const HTTPS_PORT_KEY = "ingress.https_port";

const TLS_MODES: readonly TlsMode[] = ["off", "auto"];

function readValues(store: Store): Map<string, string> {
  const rows = store.db
    .prepare(
      "SELECT key, value FROM settings WHERE key IN (?, ?, ?)",
    )
    .all(TLS_KEY, HTTP_PORT_KEY, HTTPS_PORT_KEY) as unknown as Array<{
    key: string;
    value: string;
  }>;
  return new Map(rows.map((row) => [row.key, row.value]));
}

function parseTls(raw: string | undefined): TlsMode {
  return raw === "auto" ? "auto" : "off";
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? value : fallback;
}

/** The stored ingress settings, with defaults for anything unset. */
export function getIngressSettings(store: Store): IngressSettings {
  const values = readValues(store);
  return {
    tls: parseTls(values.get(TLS_KEY)),
    httpPort: parsePort(values.get(HTTP_PORT_KEY), DEFAULT_INGRESS_SETTINGS.httpPort),
    httpsPort: parsePort(values.get(HTTPS_PORT_KEY), DEFAULT_INGRESS_SETTINGS.httpsPort),
  };
}

function validateTls(mode: string): TlsMode {
  if (!TLS_MODES.includes(mode as TlsMode)) {
    throw new ValidationError(
      "tls",
      `invalid TLS mode "${mode}": use off or auto`,
    );
  }
  return mode as TlsMode;
}

function validateIngressPort(
  port: number,
  field: "httpPort" | "httpsPort",
): number {
  try {
    return validatePort(port);
  } catch (error) {
    if (error instanceof ValidationError) {
      const label = field === "httpPort" ? "http" : "https";
      throw new ValidationError(field, `invalid ${label} port ${port}`);
    }
    throw error;
  }
}

/**
 * Store the values given, leaving the rest untouched, and return the merged
 * settings. Every value is validated before anything is written, so invalid
 * input stores nothing.
 */
export function setIngressSettings(
  store: Store,
  changes: Partial<IngressSettings>,
): IngressSettings {
  const current = getIngressSettings(store);

  const tls =
    changes.tls === undefined ? current.tls : validateTls(changes.tls);
  const httpPort =
    changes.httpPort === undefined
      ? current.httpPort
      : validateIngressPort(changes.httpPort, "httpPort");
  const httpsPort =
    changes.httpsPort === undefined
      ? current.httpsPort
      : validateIngressPort(changes.httpsPort, "httpsPort");

  if (httpPort === httpsPort) {
    throw new ValidationError(
      "httpsPort",
      `https port ${httpsPort} is also the http port`,
    );
  }

  const writes: Array<[string, string]> = [];
  if (changes.tls !== undefined) {
    writes.push([TLS_KEY, tls]);
  }
  if (changes.httpPort !== undefined) {
    writes.push([HTTP_PORT_KEY, String(httpPort)]);
  }
  if (changes.httpsPort !== undefined) {
    writes.push([HTTPS_PORT_KEY, String(httpsPort)]);
  }

  if (writes.length > 0) {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = store.db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      for (const [key, value] of writes) {
        upsert.run(key, value);
      }
      store.db.exec("COMMIT");
    } catch (error) {
      try {
        store.db.exec("ROLLBACK");
      } catch {
        // Keep the original failure.
      }
      throw error;
    }
  }

  return { tls, httpPort, httpsPort };
}
