---
title: Adapter fixes from the first integration runs
depends_on: ["007"]
verify: pnpm verify
features:
  reads: []
---
## Goal

The Docker adapter passes the whole contract suite against real engines. The first integration runs (recorded in `docs/integration-testing.md`) found three contract violations the offline tests could not see:
- Docker's container list lags behind inspect (Docker 24.0.7: 11 of 12).
- Podman reports a missing image inside the pull stream.
- Podman 3.4 reports a name conflict as HTTP 500 (Podman 3.4.4: 10 of 12).

This change fixes all three, records them as engine differences in the spec, and labels the integration suite with the engine's name. It also removes the global `interface Object` shim that change 007 left in the contract suite by giving the three frozen deploy test doubles a `networkExists` delegate.

## Verify

`pnpm verify`

It typechecks `src/` and `tests/` without the shim and runs every unit test offline. The new stub tests reproduce each engine behavior as the integration runs observed it. After each task it must pass.

## Non-goals

- New engines, remote engines, or new socket locations.
- Changes to the `ContainerRuntime` interface.
- Changes to `deployments` behavior. The three deploy test doubles only gain a delegating method.
- Updating `docs/integration-testing.md`; that is a human step after the integration rerun.

## Surface

- Changed: `pnpm test:integration` suite name, now `container runtime contract: <engine> (<socket>)` instead of `docker (<socket>)`

## Contract

The full contract is the `container-runtime` delta in `specs/container-runtime/spec.md`. In short:

### Requirement: List state matches inspection

`listContainers` SHALL report the state inspection reports, leaving out containers that vanish while listing.

#### Scenario: Stopped container in a lagging list
- **WHEN** the engine's list still reports a just-stopped container as `running` but inspecting it reports `exited`
- **THEN** `listContainers` reports it as `exited`

### Requirement: Docker and Podman differences

A missing image SHALL be `ImageNotFoundError` whether the engine reports it as a 500 or inside the pull stream; Podman 3.4's 500 name conflict SHALL be `NameConflictError`.

#### Scenario: Missing image inside the pull stream
- **WHEN** the pull request succeeds and the stream ends with an error event `requested access to the resource is denied`
- **THEN** `pullImage` fails with `ImageNotFoundError`

#### Scenario: Podman 3.4 name conflict
- **WHEN** create fails with status 500 and a message ending `that name is already in use`
- **THEN** `createContainer` fails with `NameConflictError`

## Human steps

- Review the proposal, the `container-runtime` delta, and both task bodies. Expect the approval digest to flag `tests.modify` for both tasks: task 1 changes one existing stub test in `tests/docker-runtime.test.ts`; task 2 changes the contract suite, the integration test, and the `DelegatingRuntime` classes of three deploy test files.
- Run `osq approve 008-adapter-engine-fixes` yourself.

After the change lands:

- Run `PAAS_INTEGRATION=1 pnpm test:integration` against Docker, and against rootless Podman with `PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock`. Both should report 12 of 12, with suites named `docker (...)` and `podman (...)`.
- Update the "Known results" table in `docs/integration-testing.md`.

## Delta

- `specs/container-runtime/spec.md`: modifies engine error mapping (500 name conflict on create), Docker and Podman differences (in-stream pull errors, Podman 3.4 conflicts, Docker list lag), and the integration tier (engine-named suite). Adds "List state matches inspection". Every existing scenario is kept.
- No file is shared between tasks. Task 1 owns `src/runtime/docker.ts`, `tests/docker-runtime.test.ts` and the new `tests/docker-engine-fixes.test.ts`. Task 2 owns `tests/support/runtime-contract.ts`, `tests/integration/docker.itest.ts`, the three deploy test files and the new `tests/contract-hygiene.test.ts`.
