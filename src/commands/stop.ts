import type { Command } from "commander";

import { stopApp } from "../deployments/stop.js";
import { runAction, withEngine, type CommandContext } from "./context.js";

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
        });
      });
    });
}
