import type { Command } from "commander";

import { writeOutput } from "../output.js";
import { getApp, updateApp, type AppChanges } from "../state/apps.js";
import { latestDeployment } from "../state/deployments.js";
import {
  failUsage,
  runAction,
  withStore,
  type CommandContext,
} from "./context.js";
import {
  collect,
  formatAppDetails,
  parseEnvPairs,
  parsePort,
  toAppView,
} from "./format.js";

interface SetOptions {
  image?: string;
  port?: string;
  host?: string;
  unsetHost?: boolean;
  env?: string[];
  unsetEnv?: string[];
  json?: boolean;
}

export function registerAppsSet(apps: Command, context: CommandContext): void {
  apps
    .command("set")
    .description("change an app")
    .argument("<name>")
    .option("--image <ref>", "container image reference")
    .option("--port <n>", "internal port")
    .option("--host <hostname>", "hostname that routes to the app")
    .option("--unset-host", "clear the hostname")
    .option(
      "--env <KEY=VALUE>",
      "set an environment variable (repeatable)",
      collect,
    )
    .option(
      "--unset-env <KEY>",
      "remove an environment variable (repeatable)",
      collect,
    )
    .option("--json", "print JSON")
    .action(async (name: string, options: SetOptions, command: Command) => {
      await runAction(command, async () => {
        const hasImage = options.image !== undefined;
        const hasPort = options.port !== undefined;
        const hasHost = options.host !== undefined;
        const hasUnsetHost = options.unsetHost === true;
        const envPairs = parseEnvPairs(options.env ?? []);
        const unsetEnv = options.unsetEnv ?? [];
        const hasEnv = options.env !== undefined;
        const hasUnsetEnv = unsetEnv.length > 0;

        if (hasHost && hasUnsetHost) {
          failUsage(command, "--host and --unset-host conflict");
        }
        for (const key of Object.keys(envPairs)) {
          if (unsetEnv.includes(key)) {
            failUsage(command, `${key} is both set and unset`);
          }
        }
        if (
          !hasImage &&
          !hasPort &&
          !hasHost &&
          !hasUnsetHost &&
          !hasEnv &&
          !hasUnsetEnv
        ) {
          failUsage(command, "nothing to change");
        }

        const port = hasPort ? parsePort(options.port ?? "") : undefined;

        await withStore(context, (store) => {
          const current = getApp(store, name);
          const changes: AppChanges = {};
          if (hasImage) {
            changes.image = options.image;
          }
          if (port !== undefined) {
            changes.port = port;
          }
          if (hasHost) {
            changes.hostname = options.host;
          }
          if (hasUnsetHost) {
            changes.hostname = null;
          }
          if (hasEnv || hasUnsetEnv) {
            const env = { ...current.env };
            for (const [key, value] of Object.entries(envPairs)) {
              env[key] = value;
            }
            for (const key of unsetEnv) {
              delete env[key];
            }
            changes.env = env;
          }

          const updated = updateApp(store, name, changes);
          const view = toAppView(updated, latestDeployment(store, name), {
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
