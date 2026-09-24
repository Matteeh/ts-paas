import type { Command } from "commander";

import { writeOutput } from "../output.js";
import { getApp } from "../state/apps.js";
import { latestDeployment } from "../state/deployments.js";
import { runAction, withStore, type CommandContext } from "./context.js";
import { formatAppDetails, toAppView } from "./format.js";

interface ShowOptions {
  reveal?: boolean;
  json?: boolean;
}

export function registerAppsShow(apps: Command, context: CommandContext): void {
  apps
    .command("show")
    .description("show one app")
    .argument("<name>")
    .option("--reveal", "reveal environment values")
    .option("--json", "print JSON")
    .action(async (name: string, options: ShowOptions, command: Command) => {
      await runAction(command, async () => {
        await withStore(context, (store) => {
          const app = getApp(store, name);
          const view = toAppView(app, latestDeployment(store, name), {
            reveal: options.reveal === true,
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
