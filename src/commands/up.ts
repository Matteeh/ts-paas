import type { Command } from "commander";

import { PAAS_NETWORK } from "../deployments/types.js";
import { ingressUp } from "../ingress/caddy.js";
import type { IngressSettings } from "../state/settings.js";
import type { CommandContext } from "./context.js";
import { getAdmin, runAction, withEngine } from "./context.js";
import { formatDoctor, type DoctorReport } from "./doctor.js";
import { parsePort } from "./format.js";
import { formatIngressUp } from "./ingress.js";

interface UpOptions {
  tls?: string;
  httpPort?: string;
  httpsPort?: string;
}

const NEXT_COMMAND =
  "next: paas apps create <name> --image <ref> --port <n> --host <name>.localhost";

export function registerUp(program: Command, context: CommandContext): void {
  program
    .command("up")
    .description("bring the local platform up")
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
          await deps.runtime.ensureNetwork(PAAS_NETWORK);

          const info = await deps.runtime.ping();
          const paasNet = await deps.runtime.networkExists(PAAS_NETWORK);
          const report: DoctorReport = {
            socket: info.endpoint ?? null,
            engine: info.name,
            version: info.version,
            apiVersion: info.apiVersion ?? null,
            paasNet,
          };

          const result = await ingressUp(
            { ...deps, admin: getAdmin(context) },
            changes,
          );

          context.io.out(
            `${formatDoctor(report)}\n${formatIngressUp(result)}\n` +
              `${NEXT_COMMAND}\n`,
          );
        });
      });
    });
}
