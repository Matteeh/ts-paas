import type { Command } from "commander";

import { deploy } from "../deployments/engine.js";
import type { EngineDeps } from "../deployments/types.js";
import { updateApp } from "../state/apps.js";
import { runAction, withEngine, type CommandContext } from "./context.js";

interface DeployCliOptions {
  image?: string;
  json?: boolean;
}

/** The first line of a deployment error. */
function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
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

          const result = await deploy(deps, app);

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
