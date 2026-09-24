import type { Command } from "commander";

import { stopApp } from "../deployments/stop.js";
import { syncIngress } from "../ingress/caddy.js";
import {
  getAdmin,
  runAction,
  withEngine,
  type CommandContext,
} from "./context.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerStop(program: Command, context: CommandContext): void {
  program
    .command("stop")
    .description("stop an app")
    .argument("<app>")
    .action(async (app: string, _options: unknown, command: Command) => {
      await runAction(command, async () => {
        await withEngine(context, async (deps) => {
          const deployment = await stopApp(deps, app);
          context.io.out(`stopped ${app} (deployment ${deployment.id})\n`);

          try {
            await syncIngress({
              store: deps.store,
              runtime: deps.runtime,
              clock: deps.clock,
              admin: getAdmin(context),
            });
          } catch (error) {
            throw new Error(
              `${app} is stopped, but ingress update failed: ${errorMessage(error)}`,
            );
          }
        });
      });
    });
}
