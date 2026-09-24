import type { Command } from "commander";

import { PAAS_NETWORK } from "../deployments/types.js";
import { writeOutput } from "../output.js";
import { getRuntime, runAction, type CommandContext } from "./context.js";

/** What `paas doctor` reports about the engine. */
export interface DoctorReport {
  socket: string | null;
  engine: string;
  version: string;
  apiVersion: string | null;
  paasNet: boolean;
}

const LABEL_WIDTH = 10;

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

/** The four human-readable doctor lines. */
export function formatDoctor(report: DoctorReport): string {
  return [
    line("socket:", report.socket ?? "-"),
    line("engine:", `${report.engine} ${report.version}`),
    line("api:", report.apiVersion ?? "-"),
    line("paas-net:", report.paasNet ? "present" : "missing"),
  ].join("\n");
}

export function registerDoctor(program: Command, context: CommandContext): void {
  program
    .command("doctor")
    .description("check the container engine")
    .option("--json", "print JSON")
    .action(async (options: { json?: boolean }, command: Command) => {
      await runAction(command, async () => {
        const runtime = getRuntime(context);
        const info = await runtime.ping();
        const paasNet = await runtime.networkExists(PAAS_NETWORK);
        const report: DoctorReport = {
          socket: info.endpoint ?? null,
          engine: info.name,
          version: info.version,
          apiVersion: info.apiVersion ?? null,
          paasNet,
        };
        writeOutput(
          context.io,
          report,
          { json: options.json === true },
          formatDoctor,
        );
      });
    });
}
