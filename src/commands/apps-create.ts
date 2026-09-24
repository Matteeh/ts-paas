import type { Command } from "commander";

import { writeOutput } from "../output.js";
import { createApp } from "../state/apps.js";
import { latestDeployment } from "../state/deployments.js";
import { runAction, withStore, type CommandContext } from "./context.js";
import {
  collect,
  formatAppDetails,
  parseEnvPairs,
  parsePort,
  toAppView,
} from "./format.js";

interface CreateOptions {
  image: string;
  port: string;
  host?: string;
  env?: string[];
  json?: boolean;
}

export function registerAppsCreate(
  apps: Command,
  context: CommandContext,
): void {
  apps
    .command("create")
    .description("create an app")
    .argument("<name>")
    .requiredOption("--image <ref>", "container image reference")
    .requiredOption("--port <n>", "internal port")
    .option("--host <hostname>", "hostname that routes to the app")
    .option(
      "--env <KEY=VALUE>",
      "set an environment variable (repeatable)",
      collect,
    )
    .option("--json", "print JSON")
    .action(async (name: string, options: CreateOptions, command: Command) => {
      await runAction(command, async () => {
        const port = parsePort(options.port);
        const env = parseEnvPairs(options.env ?? []);

        await withStore(context, (store) => {
          const app = createApp(store, {
            name,
            image: options.image,
            port,
            hostname: options.host ?? null,
            env,
          });
          const view = toAppView(app, latestDeployment(store, app.name), {
            reveal: false,
          });
          writeOutput(
            context.io,
            view,
            { json: options.json === true },
            formatAppDetails,
          );
        });
      });
    });
}
