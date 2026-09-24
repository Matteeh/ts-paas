import type { Command } from "commander";

import { deploy } from "../deployments/engine.js";
import type { EngineDeps } from "../deployments/types.js";
import { syncIngress } from "../ingress/caddy.js";
import { updateApp } from "../state/apps.js";
import type { Deployment } from "../state/deployments.js";
import {
  getAdmin,
  runAction,
  withEngine,
  type CommandContext,
} from "./context.js";

interface DeployCliOptions {
  image?: string;
  json?: boolean;
}

/** The first line of a deployment error. */
function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerDeploy(program: Command, context: CommandContext): void {
  program
    .command("deploy")
    .description("deploy an app")
    .argument("<app>")
    .option("--image <ref>", "image to deploy")
    .option("--json", "print JSON")
    .action(async (app: string, options: DeployCliOptions, command: Command) => {
      await runAction(command, async () => {
        await withEngine(context, async (base) => {
          if (options.image !== undefined) {
            updateApp(base.store, app, { image: options.image });
          }

          const json = options.json === true;
          const deps: EngineDeps = json
            ? base
            : {
                ...base,
                onProgress: (event) => {
                  context.io.out(`${event.status}: ${event.message}\n`);
                },
              };

          let running: Deployment | undefined;
          let ingressError: unknown;

          let result: Deployment;
          try {
            result = await deploy(deps, app, {
              onRunning: async (deployment) => {
                running = deployment;
                try {
                  await syncIngress({
                    store: base.store,
                    runtime: base.runtime,
                    clock: base.clock,
                    admin: getAdmin(context),
                  });
                } catch (error) {
                  ingressError = error;
                  throw error;
                }
              },
            });
          } catch (error) {
            if (ingressError !== undefined && error === ingressError) {
              if (json && running !== undefined) {
                context.io.out(`${JSON.stringify(running)}\n`);
              }
              throw new Error(
                `deployment ${running?.id ?? ""} is running, but ingress update failed: ${errorMessage(error)}`,
              );
            }
            throw error;
          }

          if (result.status === "failed") {
            if (json) {
              context.io.out(`${JSON.stringify(result)}\n`);
            } else if (result.error !== null) {
              for (const line of result.error.split("\n").slice(1)) {
                context.io.out(`  | ${line}\n`);
              }
            }
            throw new Error(
              `deployment ${result.id} failed: ${firstLine(result.error ?? "")}`,
            );
          }

          if (json) {
            context.io.out(`${JSON.stringify(result)}\n`);
          } else {
            context.io.out(`${app} is running (deployment ${result.id})\n`);
          }
        });
      });
    });
}
