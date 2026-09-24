---
title: Reconcile
depends_on: ["010"]
verify: pnpm verify
features:
  reads: []
---
## Goal

`paas reconcile` brings stored state and the running engine back into agreement after a crash, a host reboot or manual `docker` commands, and reports every change it makes. It fails deployments whose containers disappeared, exited or never finished starting. It reports orphaned app containers, and removes them with `--prune`. With `--redeploy`, it deploys again the apps that lost their container. It pushes the ingress config whenever something changed or Caddy's routes are out of date, which also restores routes after Caddy restarts on its own (a non-goal of change 009). `paas status` warns in one line when reconcile would change something.

## Verify

`pnpm verify`

It typechecks `src/` and `tests/` and runs every unit test offline. Each reconcile case runs as a test against the fake runtime and the injected clock, then through `paas reconcile` and `paas status` in-process with a fake admin client. After each task it must pass.

## Non-goals

- A background loop or daemon.
- Scheduling, or restarts beyond the engine's restart policy.
- A flag for the stuck threshold. It is ten minutes; the core function takes it as a parameter for tests.
- Removing containers that carry no `paas.app` label. `paas-caddy`, `paas-test-caddy` and contract-suite containers are never orphans.
- Fixing a deployment whose container is running but whose record says otherwise, such as a `stopped` deployment whose container someone started again. It shows up as an orphan.

## Surface

- Added: `paas reconcile` (command) with `--dry-run`, `--prune`, `--redeploy`, `--json` (flags)
- Added: deployment error `container disappeared`
- Added: deployment error `stuck in <status> since <time>`
- Changed: `paas status` and `paas status <app>` print `paas: warning: state and engine disagree on <n> item(s); run paas reconcile --dry-run` to stderr when reconcile would act

## Contract

The full contract is in `specs/deployments/spec.md` and `specs/cli/spec.md`. Each reconcile case is a scenario there. In short:

### Requirement: Reconcile plan

`planReconcile` SHALL fail running deployments whose container is missing or not running, fail deployments stuck in `pending`, `pulling` or `starting` for more than ten minutes, and report as orphans the app containers that no running or in-flight deployment owns.

#### Scenario: Container disappeared
- **WHEN** `web`'s running deployment's container no longer exists
- **THEN** reconcile marks the deployment `failed` with error `container disappeared`

#### Scenario: Caddy is never an orphan
- **WHEN** `paas-caddy` runs and no deployment owns it
- **THEN** it is not reported as an orphan

### Requirement: Drift warning

`paas status` SHALL print one warning line to stderr when reconcile would act, and SHALL print nothing extra when the engine cannot be reached.

#### Scenario: Unreachable engine
- **WHEN** `PAAS_SOCKET` names a missing path and a user runs `paas status`
- **THEN** stderr is empty and the exit code is 0

## Human steps

- Review the proposal, both deltas and the three task bodies. Expect the approval digest to flag `tests.modify` for task 3. It changes one test in `tests/status-logs-cli.test.ts`, "status prints the aligned overview with uptime and dashes", which seeds a running deployment with no container and now also gets the drift warning.
- Run `osq approve 011-reconcile` yourself.

After the change lands, optionally try it on a real engine:

- Deploy an app, remove its container with `docker rm -f`, then run `paas status`, `paas reconcile --dry-run`, and `paas reconcile --redeploy`.
- With ingress up, run `docker restart paas-caddy`, then `paas reconcile`. It should report `push-ingress` and restore the routes.

## Delta

- `specs/deployments/spec.md`: adds "Reconcile plan", "Reconcile: container missing", "Reconcile: container not running", "Reconcile: stuck deployments", "Reconcile: orphans" and "Applying a reconcile plan".
- `specs/cli/spec.md`: adds "Reconcile command", "Reconcile output", "Reconcile JSON", "Reconcile redeploy and ingress" and "Drift warning"; modifies "Status overview" so it no longer says `paas status` reads only the state store. The brief lists only `deployments`, but the command and the `status` change live in `src/commands/`, which `cli` owns.
- No file is shared between tasks. Task 1 owns `src/deployments/reconcile.ts`; task 2 owns `src/commands/reconcile.ts` and `src/program.ts`; task 3 owns `src/commands/status.ts` and the one edited test in `tests/status-logs-cli.test.ts`. Task 3 calls `runReconcile` from task 2's file without editing it.
