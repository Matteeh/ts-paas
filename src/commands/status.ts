import type { Command } from "commander";

import { writeOutput } from "../output.js";
import { getApp, listApps, type App } from "../state/apps.js";
import type { Store } from "../state/db.js";
import {
  deploymentHistory,
  deploymentStatusChanges,
  latestDeployment,
  type Deployment,
  type DeploymentStatus,
} from "../state/deployments.js";
import {
  contextClock,
  getAdmin,
  getRuntime,
  runAction,
  withStore,
  type CommandContext,
} from "./context.js";
import { formatTable } from "./format.js";
import { formatUptime, shortContainerId } from "./deploy-helpers.js";
import { runReconcile } from "./reconcile.js";

const OVERVIEW_HEADERS = [
  "APP",
  "STATUS",
  "CONTAINER",
  "IMAGE",
  "UPTIME",
] as const;
const DEPLOYMENT_HEADERS = [
  "ID",
  "STATUS",
  "IMAGE",
  "CREATED",
  "FINISHED",
  "ERROR",
] as const;

interface Overview {
  app: string;
  status: DeploymentStatus | null;
  deploymentId: string | null;
  containerId: string | null;
  image: string;
  runningSince: string | null;
  uptimeSeconds: number | null;
}

/** When the deployment last entered `running`, or `null`. */
function runningSince(store: Store, deployment: Deployment): string | null {
  if (deployment.status !== "running") {
    return null;
  }
  const change = deploymentStatusChanges(store, deployment.id).find(
    (entry) => entry.status === "running",
  );
  return change?.at ?? null;
}

function overviewFor(store: Store, app: App, now: Date): Overview {
  const latest = latestDeployment(store, app.name);
  const since = latest === null ? null : runningSince(store, latest);
  const uptimeSeconds =
    since === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / 1_000));

  return {
    app: app.name,
    status: latest?.status ?? null,
    deploymentId: latest?.id ?? null,
    containerId: latest?.containerId ?? null,
    image: latest?.image ?? app.image,
    runningSince: since,
    uptimeSeconds,
  };
}

function overviewCells(overview: Overview): string[] {
  return [
    overview.app,
    overview.status ?? "-",
    shortContainerId(overview.containerId) ?? "-",
    overview.image,
    overview.uptimeSeconds === null
      ? "-"
      : formatUptime(overview.uptimeSeconds * 1_000),
  ];
}

function formatOverview(rows: readonly Overview[]): string {
  if (rows.length === 0) {
    return "no apps";
  }
  return formatTable(OVERVIEW_HEADERS, rows.map(overviewCells));
}

/**
 * Warn once when a dry-run reconcile would change something. Best effort: an
 * unreachable engine or any check failure is swallowed without output.
 */
async function warnDrift(store: Store, context: CommandContext): Promise<void> {
  try {
    const runtime = getRuntime(context);
    await runtime.ping();
    const report = await runReconcile(
      {
        store,
        runtime,
        clock: contextClock(context),
        admin: getAdmin(context),
      },
      { dryRun: true, prune: false, redeploy: false },
    );
    if (report.items.length > 0) {
      context.io.err(
        `paas: warning: state and engine disagree on ${report.items.length} item(s); run paas reconcile --dry-run\n`,
      );
    }
  } catch {
    // Status must still succeed when the engine cannot be reached.
  }
}

function formatOne(overview: Overview, deployments: readonly Deployment[]): string {
  const overviewTable = formatTable(OVERVIEW_HEADERS, [overviewCells(overview)]);
  const historyTable = formatTable(
    DEPLOYMENT_HEADERS,
    deployments.map((deployment) => [
      deployment.id,
      deployment.status,
      deployment.image,
      deployment.createdAt,
      deployment.finishedAt ?? "-",
      deployment.error === null
        ? "-"
        : (deployment.error.split("\n", 1)[0] ?? "-"),
    ]),
  );
  return `${overviewTable}\n\n${historyTable}`;
}

export function registerStatus(program: Command, context: CommandContext): void {
  program
    .command("status")
    .description("show deployment status")
    .argument("[app]")
    .option("--json", "print JSON")
    .action(
      async (
        app: string | undefined,
        options: { json?: boolean },
        command: Command,
      ) => {
        await runAction(command, async () => {
          await withStore(context, async (store) => {
            const now = contextClock(context).now();

            if (app === undefined) {
              const rows = listApps(store).map((entry) =>
                overviewFor(store, entry, now),
              );
              writeOutput(
                context.io,
                rows,
                { json: options.json === true },
                formatOverview,
              );
              await warnDrift(store, context);
              return;
            }

            const overview = overviewFor(store, getApp(store, app), now);
            const deployments = deploymentHistory(store, app, { limit: 5 });
            if (options.json === true) {
              context.io.out(
                `${JSON.stringify({ ...overview, deployments })}\n`,
              );
            } else {
              context.io.out(`${formatOne(overview, deployments)}\n`);
            }
            await warnDrift(store, context);
          });
        });
      },
    );
}
