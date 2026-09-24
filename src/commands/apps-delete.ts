import type { Command } from "commander";

import { deleteApp } from "../state/apps.js";
import { runAction, withStore, type CommandContext } from "./context.js";

export function registerAppsDelete(
  apps: Command,
  context: CommandContext,
): void {
  apps
    .command("delete")
    .description("delete an app")
    .argument("<name>")
    .action(async (name: string, _options: unknown, command: Command) => {
      await runAction(command, async () => {
        await withStore(context, (store) => {
          deleteApp(store, name);
        });
        context.io.out(`deleted app ${name}\n`);
      });
    });
}
