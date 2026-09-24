import type { Command } from "commander";

import { registerAppsCreate } from "./apps-create.js";
import { registerAppsDelete } from "./apps-delete.js";
import { registerAppsList } from "./apps-list.js";
import { registerAppsShow } from "./apps-show.js";
import { registerAppsSet } from "./apps-set.js";
import type { CommandContext } from "./context.js";

export function registerAppsCommand(
  program: Command,
  context: CommandContext,
): void {
  const apps = program.command("apps").description("manage apps");

  registerAppsCreate(apps, context);
  registerAppsList(apps, context);
  registerAppsShow(apps, context);
  registerAppsSet(apps, context);
  registerAppsDelete(apps, context);
}
