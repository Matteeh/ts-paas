import { Command, CommanderError } from "commander";

import { registerAppsCommand } from "./commands/apps.js";
import type { CommandContext } from "./commands/context.js";
import { registerDeploy } from "./commands/deploy.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerIngressCommand } from "./commands/ingress.js";
import { registerLogs } from "./commands/logs.js";
import { registerStatus } from "./commands/status.js";
import { registerStop } from "./commands/stop.js";
import type { Clock } from "./clock.js";
import { UsageError } from "./errors.js";
import type { CaddyAdmin } from "./ingress/admin.js";
import { processIo, type Io } from "./output.js";
import type { ContainerRuntime } from "./runtime/types.js";
import { packageVersion } from "./version.js";

export function buildProgram(
  io: Io = processIo,
  options: {
    env?: NodeJS.ProcessEnv;
    runtime?: () => ContainerRuntime;
    clock?: Clock;
    admin?: () => CaddyAdmin;
  } = {},
): Command {
  const program = new Command();

  program
    .name("paas")
    .description("deploy applications to your own PaaS")
    .version(packageVersion())
    .exitOverride()
    .showHelpAfterError()
    .configureOutput({
      writeOut: (text) => {
        io.out(text);
      },
      writeErr: (text) => {
        io.err(text);
      },
      outputError: (text, write) => {
        write(text.replace(/^error: /, "paas: "));
      },
    })
    .action(() => {
      program.outputHelp();
    });

  const context: CommandContext = {
    io,
    env: options.env ?? process.env,
    runtime: options.runtime,
    clock: options.clock,
    admin: options.admin,
  };

  registerAppsCommand(program, context);
  registerDeploy(program, context);
  registerStatus(program, context);
  registerLogs(program, context);
  registerStop(program, context);
  registerDoctor(program, context);
  registerIngressCommand(program, context);

  return program;
}

export async function run(
  argv: readonly string[],
  io: Io = processIo,
  program: Command = buildProgram(io),
): Promise<number> {
  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    if (error instanceof UsageError) {
      io.err(`paas: ${error.message}\n`);
      program.outputHelp({ error: true });
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`paas: ${message}\n`);
    return 1;
  }
}
