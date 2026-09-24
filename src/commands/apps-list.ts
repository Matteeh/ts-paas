import type { Command } from "commander";

import { writeOutput } from "../output.js";
import { listApps } from "../state/apps.js";
import { latestDeployment, type DeploymentStatus } from "../state/deployments.js";
import { runAction, withStore, type CommandContext } from "./context.js";
import { formatTable } from "./format.js";

interface ListRow {
  name: string;
  image: string;
  port: number;
  hostname: string | null;
  status: DeploymentStatus | null;
  createdAt: string;
  updatedAt: string;
}

interface ListOptions {
  json?: boolean;
}

function formatList(rows: readonly ListRow[]): string {
  if (rows.length === 0) {
    return "no apps";
  }
  return formatTable(
    ["NAME", "IMAGE", "PORT", "HOST", "STATUS"],
    rows.map((row) => [
      row.name,
      row.image,
      String(row.port),
      row.hostname ?? "-",
      row.status ?? "-",
    ]),
  );
}

export function registerAppsList(apps: Command, context: CommandContext): void {
  apps
    .command("list")
    .description("list apps")
    .option("--json", "print JSON")
    .action(async (options: ListOptions, command: Command) => {
      await runAction(command, async () => {
        await withStore(context, (store) => {
          const rows: ListRow[] = listApps(store).map((app) => {
            const latest = latestDeployment(store, app.name);
            return {
              name: app.name,
              image: app.image,
              port: app.port,
              hostname: app.hostname,
              status: latest === null ? null : latest.status,
              createdAt: app.createdAt,
              updatedAt: app.updatedAt,
            };
          });
          writeOutput(
            context.io,
            rows,
            { json: options.json === true },
            formatList,
          );
        });
      });
    });
}
