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

/** `fetch` could not reach Caddy's admin API at all. */
export class AdminUnreachableError extends IngressError {}

/** Caddy's admin API answered with a non-2xx status. */
export class AdminRequestError extends IngressError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The message for an unreachable admin API: `cause.code`, else its message. */
function unreachableCause(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const cause = (error as { cause?: unknown }).cause;
    if (typeof cause === "object" && cause !== null) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
      if (cause instanceof Error) {
        return cause.message;
      }
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

/** Talks to Caddy over its HTTP admin API. */
export class HttpCaddyAdmin implements CaddyAdmin {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async load(config: CaddyConfig): Promise<void> {
    await this.request("/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  }

  async getConfig(): Promise<unknown> {
    const response = await this.request("/config/", { method: "GET" });
    return response.json();
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (error) {
      throw new AdminUnreachableError(
        `cannot reach Caddy admin API at ${this.baseUrl}: ${unreachableCause(error)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new AdminRequestError(
        response.status,
        `Caddy admin API answered ${response.status}: ${firstLine(body)}`,
      );
    }

    return response;
  }
}
