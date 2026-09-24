---
title: Deployment engine
depends_on: ["002", "003"]
verify: pnpm verify
features:
  reads:
    - container-runtime
    - app-state
---
## Goal

One module takes an app from its stored spec to a running container through `ContainerRuntime`, records every status change through the `app-state` repository, and never takes down an app's working container when a new deployment fails. A separate function stops an app. Everything is proven against `FakeRuntime` and `FakeClock`; no test waits on real time. `deploy-cli` drives this engine next, and `ingress-caddy` later hooks into the step between "new deployment running" and "previous container removed".

## Verify

`pnpm verify`

It typechecks and runs every unit test offline, including the health check, deploy flow and stop tests on the fake runtime and fake clock. After each task it must pass.

## Non-goals

- TCP or HTTP health checks.
- Several replicas per app.
- A rollback command.
- Updating ingress. `ingress-caddy` adds its hook to `src/deployments/engine.ts`.
- Any `paas` command, and any change to `container-runtime` or `app-state`.
- Clearing deployments stuck in `pending`, `pulling` or `starting` after a crash; they block new deploys until `reconcile` fails them.

## Surface

- Added: `paas.app=<app>` (container label)
- Added: `paas.deployment=<deployment id>` (container label)
- Added: `<app>-<deployment id>` (container name)
- Added: `paas-net` (container network every app container joins)

## Contract

The full contract, with the flow as scenarios, is the `deployments` delta in `specs/deployments/spec.md`. In short:

### Requirement: Health window

A started container SHALL be healthy when, at the end of a window on the injected clock (3 s by default), it is still `running` with restart count 0 and an unchanged start time.

#### Scenario: Restarted by the engine
- **WHEN** the container is `running` at the end of the window but its restart count is 1
- **THEN** the deployment fails with `container restarted during the health window`

### Requirement: Replacement after health

Only after the new deployment is `running` SHALL the engine remove the previous container and mark that deployment `replaced`.

#### Scenario: Redeploy replaces
- **WHEN** app `web` has running deployment A and a new deploy B becomes healthy
- **THEN** B is `running`, A is `replaced` with a finish time, A's container is gone, and B was marked `running` before A was marked `replaced`

### Requirement: Failed removal of the previous container

A failure to remove the previous container SHALL still mark it `replaced`, leave the container to reconcile as an orphan, and keep the new deployment `running`.

#### Scenario: Previous container cannot be removed
- **WHEN** removing deployment A's container fails with a runtime error while B replaces it
- **THEN** B is `running`, A is `replaced`, `deploy` resolves, and the `replaced` progress message contains the runtime error's message

### Requirement: Health failure

A failed health window SHALL fail the new deployment with its exit code and last 20 log lines, remove its container, and leave the previous deployment running.

#### Scenario: Failure keeps the previous deployment
- **WHEN** app `web` has a running deployment and a new deploy's container exits with code 3 after writing 25 log lines
- **THEN** the new deployment is `failed`, its error starts with `container exited with code 3` and contains exactly the last 20 lines, its container is gone, and the previous deployment and its container are still running

## Human steps

- Review the proposal, the `deployments` delta (the scenarios are the flow), and the three task bodies.
- Run `osq approve 005-deployment-engine` yourself.

## Delta

- `specs/deployments/spec.md`: new `deployments` capability (Purpose, flow, container spec, health window, health failure, replacement, failed removal of the previous container, pull failure, runtime errors, one deploy at a time, deploy result, progress, stopping, code ownership).
- No file is shared between tasks. Task 1 owns `src/deployments/types.ts`, `errors.ts` and `health.ts`; task 2 owns `engine.ts`; task 3 owns `stop.ts`.
