---
title: Container runtime interface and fake
depends_on: ["001"]
verify: pnpm verify
features:
  reads: []
---
## Goal

Give paas one engine-neutral `ContainerRuntime` interface, an injected `Clock`, typed runtime errors, a deterministic in-memory `FakeRuntime`, and a reusable contract suite that every runtime implementation must pass. Later changes (deployment engine, ingress, reconcile) build only against this interface and prove their behavior on the fake. The `docker-podman-adapter` change will run the same contract suite against Docker and Podman. No real engine is involved here.

## Verify

`pnpm verify`

It typechecks `src/` and `tests/` and runs every unit test offline, including the contract suite against `FakeRuntime`. Before this change the new tests do not exist; after each task it must pass.

## Non-goals

- dockerode or any real engine. Nothing in this change imports an engine client.
- Image builds.
- TCP or HTTP health checks, restarts, or scheduling. The fake records the restart policy and never acts on it.
- Any `paas` command. The `cli` capability is untouched.
- Adding, removing, or upgrading dependencies.

## Surface

- Added: `paas.managed=true` (container label on every container paas creates)

## Contract

The full contract is the `container-runtime` delta in `specs/container-runtime/spec.md`. In short:

### Requirement: Runtime interface

paas SHALL reach a container engine only through `ContainerRuntime`, whose operations accept a container id or name, and whose types reference no engine client library.

#### Scenario: Container is addressed by id or name
- **WHEN** a container named `web` is created and its id is returned
- **THEN** `inspectContainer` with the id and with `web` return the same container

### Requirement: Managed label

Every created container SHALL carry `paas.managed=true`, added by the runtime.

#### Scenario: Runtime adds the managed label
- **WHEN** a container is created with labels `{ "paas.app": "web" }`
- **THEN** its inspected labels include `paas.app=web` and `paas.managed=true`

### Requirement: Inspection

Inspection SHALL return state (`created`, `running`, `exited`), exit code, start and finish times, and restart count. The restart count is there so the deployment engine can tell a restarted container from a healthy one on real engines.

#### Scenario: Fresh container inspection
- **WHEN** a container is created and not started
- **THEN** its state is `created`, exit code, start time and finish time are `null`, and restart count is 0

### Requirement: Fake runtime

The fake SHALL be scriptable: failing pulls, containers that exit immediately or after a delay on the injected clock, scripted log lines, and an unavailable engine.

#### Scenario: Container exits after a delay
- **WHEN** image `slow:1` is scripted to exit with code 1 after 2000 ms, a container from it is started, and the fake clock advances 2000 ms
- **THEN** it is `running` before the advance and `exited` with code 1 after it

## Human steps

- Review the proposal, the `container-runtime` delta, and both task bodies.
- Run `osq approve 002-runtime-interface` yourself.

## Delta

- `specs/container-runtime/spec.md`: new `container-runtime` capability (Purpose, interface, managed label, lifecycle, inspection, images/networks/volumes, logs, typed errors, clock, fake runtime, contract suite, code ownership).
- No file is shared between tasks. Task 1 owns the ports (`src/clock.ts`, `src/runtime/types.ts`, `src/runtime/errors.ts`); task 2 owns the fake and the contract suite.
