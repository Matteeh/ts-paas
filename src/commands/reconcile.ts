import type { Command } from "commander";

import { deploy } from "../deployments/engine.js";
import {
  applyReconcile,
  planReconcile,
  type ReconcileItem,
  type ReconcileOutcome,
} from "../deployments/reconcile.js";
import type { IngressDeps } from "../ingress/caddy.js";
import { DEFAULT_TARGET, ingressStatus, syncIngress } from "../ingress/caddy.js";
import { desiredRoutes, type IngressRoute } from "../ingress/config.js";
import { writeOutput } from "../output.js";
import { deploymentHistory } from "../state/deployments.js";
import {
  getAdmin,
  runAction,
  withEngine,
  type CommandContext,
} from "./context.js";

/** One reported reconcile item, in the shape the JSON mode prints. */
export interface ReportItem {
  kind: "fail" | "orphan" | "prune" | "redeploy" | "push-ingress";
  app: string | null;
  deploymentId: string | null;
  containerId: string | null;
  detail: string;
  ok: boolean | null;
}

export interface ReconcileReport {
  dryRun: boolean;
  items: ReportItem[];
}

interface ReconcileCliOptions {
  dryRun?: boolean;
  prune?: boolean;
  redeploy?: boolean;
  json?: boolean;
}

/**
 * Where the container name of an orphan/prune item lives. Kept out of the
 * item itself so the JSON output stays exactly the documented shape.
 */
const itemNames = new WeakMap<ReportItem, string>();

function rememberName(item: ReportItem, name: string): void {
  itemNames.set(item, name);
}

function itemName(item: ReportItem): string {
  return itemNames.get(item) ?? item.containerId ?? "-";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first line of an error, so a report line stays one line. */
function firstLine(message: string): string {
  const first = message.split("\n", 1)[0];
  return first === undefined || first === "" ? "reconcile failed" : first;
}

/** True when a planned failure is about a container, not a stuck deployment. */
function isContainerFailure(error: string): boolean {
  return !error.startsWith("stuck in ");
}

/** True when the app still has a running deployment the plan does not fail. */
function hasRunningDeploymentLeft(
  deps: IngressDeps,
  app: string,
  failed: ReadonlySet<string>,
): boolean {
  return deploymentHistory(deps.store, app).some(
    (deployment) =>
      deployment.status === "running" && !failed.has(deployment.id),
  );
}

function sameRoutes(
  a: readonly IngressRoute[],
  b: readonly IngressRoute[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (route: IngressRoute): string =>
    `${route.hostname}\u0000${route.upstream}`;
  const wanted = new Set(b.map(key));
  return a.every((route) => wanted.has(key(route)));
}

interface CaddyRoutes {
  running: boolean;
  routes: IngressRoute[] | null;
}

/** Caddy's running state and routes; unreadable routes count as different. */
async function readCaddyRoutes(deps: IngressDeps): Promise<CaddyRoutes> {
  try {
    const status = await ingressStatus(deps);
    return { running: status.caddy === "running", routes: status.routes };
  } catch {
    // Reading the config failed: keep the container state, routes unknown.
    const target = deps.target ?? DEFAULT_TARGET;
    try {
      const info = await deps.runtime.inspectContainer(target.container);
      return { running: info.state === "running", routes: null };
    } catch {
      return { running: false, routes: null };
    }
  }
}

function failItem(
  entry: Extract<ReconcileItem, { kind: "fail" }>,
  options: { dryRun: boolean },
  outcome: ReconcileOutcome | undefined,
): ReportItem {
  const base = {
    kind: "fail" as const,
    app: entry.app,
    deploymentId: entry.deploymentId,
    containerId: entry.containerId,
  };
  if (options.dryRun) {
    return { ...base, detail: entry.error, ok: null };
  }
  if (outcome?.result === "failed") {
    return {
      ...base,
      detail: `failed: ${firstLine(outcome.error ?? "")}`,
      ok: false,
    };
  }
  return { ...base, detail: entry.error, ok: true };
}

function orphanItem(
  entry: Extract<ReconcileItem, { kind: "orphan" }>,
  options: { dryRun: boolean; prune: boolean },
  outcome: ReconcileOutcome | undefined,
): ReportItem {
  const base = {
    app: entry.app,
    deploymentId: null,
    containerId: entry.containerId,
  };
  let item: ReportItem;
  if (!options.prune) {
    item = {
      kind: "orphan",
      ...base,
      detail: `app ${entry.app}; use --prune to remove`,
      ok: null,
    };
  } else if (options.dryRun) {
    item = { kind: "prune", ...base, detail: "planned", ok: null };
  } else if (outcome?.result === "failed") {
    item = {
      kind: "prune",
      ...base,
      detail: `failed: ${firstLine(outcome.error ?? "")}`,
      ok: false,
    };
  } else {
    item = { kind: "prune", ...base, detail: "removed", ok: true };
  }
  rememberName(item, entry.name);
  return item;
}

async function redeployItems(
  deps: IngressDeps,
  plan: readonly ReconcileItem[],
  options: { dryRun: boolean; redeploy: boolean },
): Promise<ReportItem[]> {
  if (!options.redeploy) {
    return [];
  }

  const failed = new Set(
    plan
      .filter((entry): entry is Extract<ReconcileItem, { kind: "fail" }> =>
        entry.kind === "fail",
      )
      .map((entry) => entry.deploymentId),
  );

  const items: ReportItem[] = [];
  const redeployed = new Set<string>();

  for (const entry of plan) {
    if (entry.kind !== "fail" || !isContainerFailure(entry.error)) {
      continue;
    }
    if (redeployed.has(entry.app)) {
      continue;
    }
    if (hasRunningDeploymentLeft(deps, entry.app, failed)) {
      continue;
    }
    redeployed.add(entry.app);

    if (options.dryRun) {
      items.push({
        kind: "redeploy",
        app: entry.app,
        deploymentId: null,
        containerId: null,
        detail: "planned",
        ok: null,
      });
      continue;
    }

    try {
      const deployment = await deploy(deps, entry.app);
      if (deployment.status === "running") {
        items.push({
          kind: "redeploy",
          app: entry.app,
          deploymentId: deployment.id,
          containerId: deployment.containerId,
          detail: `deployment ${deployment.id} is running`,
          ok: true,
        });
      } else {
        items.push({
          kind: "redeploy",
          app: entry.app,
          deploymentId: deployment.id,
          containerId: deployment.containerId,
          detail: `failed: ${firstLine(deployment.error ?? "deployment failed")}`,
          ok: false,
        });
      }
    } catch (error) {
      items.push({
        kind: "redeploy",
        app: entry.app,
        deploymentId: null,
        containerId: null,
        detail: `failed: ${firstLine(errorMessage(error))}`,
        ok: false,
      });
    }
  }

  return items;
}

/**
 * Plan and, unless `dryRun`, apply a reconcile. Prints nothing: the caller
 * formats the report. Failures and skipped actions are reported as items.
 */
export async function runReconcile(
  deps: IngressDeps,
  options: {
    dryRun: boolean;
    prune: boolean;
    redeploy: boolean;
    stuckAfterMs?: number;
  },
): Promise<ReconcileReport> {
  const plan = await planReconcile(deps, {
    stuckAfterMs: options.stuckAfterMs,
  });
  const outcomes = options.dryRun
    ? null
    : await applyReconcile(deps, plan, { prune: options.prune });

  const items: ReportItem[] = [];
  let changed = false;

  plan.forEach((entry, index) => {
    if (entry.kind === "fail") {
      changed = true;
      items.push(failItem(entry, options, outcomes?.[index]));
      return;
    }
    if (options.prune) {
      changed = true;
    }
    items.push(orphanItem(entry, options, outcomes?.[index]));
  });

  const redeploys = await redeployItems(deps, plan, options);
  if (redeploys.length > 0) {
    changed = true;
  }
  items.push(...redeploys);

  const desired = desiredRoutes(deps.store);
  const caddy = await readCaddyRoutes(deps);
  if (caddy.running) {
    const routesDiffer =
      caddy.routes === null || !sameRoutes(caddy.routes, desired);
    if (changed || routesDiffer) {
      if (options.dryRun) {
        items.push({
          kind: "push-ingress",
          app: null,
          deploymentId: null,
          containerId: null,
          detail: "planned",
          ok: null,
        });
      } else {
        try {
          await syncIngress(deps);
          items.push({
            kind: "push-ingress",
            app: null,
            deploymentId: null,
            containerId: null,
            detail: `${desired.length} routes`,
            ok: true,
          });
        } catch (error) {
          items.push({
            kind: "push-ingress",
            app: null,
            deploymentId: null,
            containerId: null,
            detail: `failed: ${firstLine(errorMessage(error))}`,
            ok: false,
          });
        }
      }
    }
  }

  return { dryRun: options.dryRun, items };
}

/** One report line for one item. */
export function formatReconcileItem(item: ReportItem): string {
  switch (item.kind) {
    case "fail":
      return `fail: ${item.app} deployment ${item.deploymentId} (${item.detail})`;
    case "orphan":
      return `orphan: ${itemName(item)} (app ${item.app}; use --prune to remove)`;
    case "prune":
      return `prune: ${itemName(item)} (${item.detail})`;
    case "redeploy":
      return `redeploy: ${item.app} (${item.detail})`;
    case "push-ingress":
      return `push-ingress: paas-caddy (${item.detail})`;
  }
}

/** The human-readable report: the dry-run banner, then one line per item. */
export function formatReconcile(report: ReconcileReport): string {
  const lines: string[] = [];
  if (report.dryRun) {
    lines.push("dry run: nothing was changed");
  }
  if (report.items.length === 0) {
    lines.push("nothing to reconcile");
  } else {
    for (const item of report.items) {
      lines.push(formatReconcileItem(item));
    }
  }
  return lines.join("\n");
}

export function registerReconcile(
  program: Command,
  context: CommandContext,
): void {
  program
    .command("reconcile")
    .description("bring state and the engine back into agreement")
    .option("--dry-run", "plan without changing anything")
    .option("--prune", "remove orphaned containers")
    .option("--redeploy", "deploy again apps that lost their container")
    .option("--json", "print JSON")
    .action(async (options: ReconcileCliOptions, command: Command) => {
      await runAction(command, async () => {
        await withEngine(context, async (deps) => {
          const report = await runReconcile(
            { ...deps, admin: getAdmin(context) },
            {
              dryRun: options.dryRun === true,
              prune: options.prune === true,
              redeploy: options.redeploy === true,
            },
          );
          writeOutput(
            context.io,
            report,
            { json: options.json === true },
            formatReconcile,
          );
          const failed = report.items.filter((item) => item.ok === false);
          if (failed.length > 0) {
            throw new Error(`reconcile had ${failed.length} failed item(s)`);
          }
        });
      });
    });
}
