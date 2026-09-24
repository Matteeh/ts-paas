import type { Command } from "commander";

import { AppNotRunningError } from "../deployments/errors.js";
import { deploymentHistory } from "../state/deployments.js";
import { runAction, withEngine, type CommandContext } from "./context.js";
import { parseDuration, parseTail } from "./deploy-helpers.js";

interface LogsOptions {
  tail?: string;
  since?: string;
  json?: boolean;
}

export function registerLogs(program: Command, context: CommandContext): void {
  program
    .command("logs")
    .description("print an app's logs")
    .argument("<app>")
    .option("--tail <n>", "number of lines from the end")
    .option("--since <duration>", "only entries from the given time ago")
    .option("--json", "print JSON")
    .action(
      async (app: string, options: LogsOptions, command: Command) => {
        await runAction(command, async () => {
          const tail =
            options.tail === undefined ? undefined : parseTail(options.tail);
          const sinceMs =
            options.since === undefined
              ? undefined
              : parseDuration(options.since);

          await withEngine(context, async (deps) => {
            const running = deploymentHistory(deps.store, app).find(
              (deployment) => deployment.status === "running",
            );
            if (running === undefined || running.containerId === null) {
              throw new AppNotRunningError(app);
            }

            const since =
              sinceMs === undefined
                ? undefined
                : new Date(deps.clock.now().getTime() - sinceMs);
            const entries = await deps.runtime.containerLogs(
              running.containerId,
              { tail, since },
            );

            if (options.json === true) {
              context.io.out(`${JSON.stringify(entries)}\n`);
              return;
            }

            for (const entry of entries) {
              if (entry.stream === "stdout") {
                context.io.out(`${entry.text}\n`);
              } else {
                context.io.err(`${entry.text}\n`);
              }
            }
          });
        });
      },
    );
}
