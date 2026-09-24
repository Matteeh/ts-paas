import { request as httpRequest } from "node:http";
import type { CaddyConfig } from "./config.js";

/** The admin URL paas talks to by default. */
export const DEFAULT_ADMIN_URL = "http://127.0.0.1:2019";

/** The two things paas asks Caddy's admin API to do. */
export interface CaddyAdmin {
  load(config: CaddyConfig): Promise<void>;
  getConfig(): Promise<unknown>;
}

/** Base class for every error the ingress capability raises. */
export class IngressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A request could not reach Caddy's admin API at all. */
export class AdminUnreachableError extends IngressError {}

/** Caddy's admin API answered with a non-2xx status. */
export class AdminRequestError extends IngressError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The message for an unreachable admin API: `error.code`, else its message. */
function unreachableCause(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    if (error instanceof Error) {
      return error.message;
    }
  }
  return String(error);
}

function firstLine(body: string): string {
  const index = body.indexOf("\n");
  return index === -1 ? body : body.slice(0, index);
}

interface AdminRequestInit {
  method: string;
  body?: string;
}

/** Talks to Caddy over its HTTP admin API. */
export class HttpCaddyAdmin implements CaddyAdmin {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async load(config: CaddyConfig): Promise<void> {
    await this.request("/load", {
      method: "POST",
      body: JSON.stringify(config),
    });
  }

  async getConfig(): Promise<unknown> {
    const body = await this.request("/config/", { method: "GET" });
    if (body === "") {
      return null;
    }
    return JSON.parse(body);
  }

  private request(path: string, init: AdminRequestInit): Promise<string> {
    const url = new URL(`${this.baseUrl}${path}`);
    const headers: Record<string, string> = {};
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(init.body));
    }

    return new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: init.method,
          headers,
          // A fresh socket per request so no kept-alive socket holds the CLI open.
          agent: false,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            body += chunk;
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(
                new AdminRequestError(
                  status,
                  `Caddy admin API answered ${status}: ${firstLine(body)}`,
                ),
              );
              return;
            }
            resolve(body);
          });
        },
      );

      req.on("error", (error) => {
        reject(
          new AdminUnreachableError(
            `cannot reach Caddy admin API at ${this.baseUrl}: ${unreachableCause(error)}`,
          ),
        );
      });

      if (init.body !== undefined) {
        req.write(init.body);
      }
      req.end();
    });
  }
}
