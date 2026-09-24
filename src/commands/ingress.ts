import type { Command } from "commander";

import {
  ingressDown,
  ingressStatus,
  ingressUp,
  type IngressStatus,
} from "../ingress/caddy.js";
import { writeOutput } from "../output.js";
import type { IngressSettings } from "../state/settings.js";
import { getAdmin, runAction, withEngine, type CommandContext } from "./context.js";
import { parsePort } from "./format.js";

const LABEL_WIDTH = 10;

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

interface UpOptions {
  tls?: string;
  httpPort?: string;
  httpsPort?: string;
}

interface StatusOptions {
  json?: boolean;
}

/** The JSON shape `paas ingress status` prints. */
export interface IngressStatusView {
  caddy: IngressStatus["caddy"];
  tls: IngressSettings["tls"];
  httpPort: number;
  httpsPort: number;
  routes: IngressStatus["routes"];
}

/** Project the ingress status into the shape the status command prints. */
export function toStatusView(status: IngressStatus): IngressStatusView {
  return {
    caddy: status.caddy,
    tls: status.settings.tls,
    httpPort: status.settings.httpPort,
    httpsPort: status.settings.httpsPort,
    routes: status.routes,
  };
}

/** The five status lines, then one line per route. */
export function formatIngressStatus(view: IngressStatusView): string {
  const lines = [
    line("caddy:", view.caddy),
    line("tls:", view.tls),
    line("http:", String(view.httpPort)),
    line("https:", String(view.httpsPort)),
    line("routes:", view.routes === null ? "-" : String(view.routes.length)),
  ];
  for (const route of view.routes ?? []) {
    lines.push(`  ${route.hostname} -> ${route.upstream}`);
  }
  return lines.join("\n");
}

export function registerIngressCommand(
  program: Command,
  context: CommandContext,
): void {
  const ingress = program.command("ingress").description("manage ingress");

  ingress
    .command("up")
    .description("bring ingress up")
    .option("--tls <mode>", "TLS mode: off or auto")
    .option("--http-port <n>", "host port for HTTP")
    .option("--https-port <n>", "host port for HTTPS")
    .action(async (options: UpOptions, command: Command) => {
      await runAction(command, async () => {
        const changes: Partial<IngressSettings> = {};
        if (options.tls !== undefined) {
          changes.tls = options.tls as IngressSettings["tls"];
        }
        if (options.httpPort !== undefined) {
          changes.httpPort = parsePort(options.httpPort);
        }
        if (options.httpsPort !== undefined) {
          changes.httpsPort = parsePort(options.httpsPort);
        }

        await withEngine(context, async (deps) => {
          const result = await ingressUp(
            { ...deps, admin: getAdmin(context) },
            changes,
          );
          context.io.out(
            `ingress is up (${result.action}): http ${result.settings.httpPort}, ` +
              `https ${result.settings.httpsPort}, tls ${result.settings.tls}, ` +
              `routes ${result.routes.length}\n`,
          );
        });
      });
    });

  ingress
    .command("down")
    .description("bring ingress down")
    .action(async (_options: unknown, command: Command) => {
      await runAction(command, async () => {
        await withEngine(context, async (deps) => {
          const removed = await ingressDown({
            ...deps,
            admin: getAdmin(context),
          });
          context.io.out(
            removed
              ? "removed paas-caddy; kept volume paas-caddy-data\n"
              : "paas-caddy does not exist\n",
          );
        });
      });
    });

  ingress
    .command("status")
    .description("show ingress status")
    .option("--json", "print JSON")
    .action(async (options: StatusOptions, command: Command) => {
      await runAction(command, async () => {
        await withEngine(context, async (deps) => {
          const status = await ingressStatus({
            ...deps,
            admin: getAdmin(context),
          });
          writeOutput(
            context.io,
            toStatusView(status),
            { json: options.json === true },
            formatIngressStatus,
          );
        });
      });
    });
}
