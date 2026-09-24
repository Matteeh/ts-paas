---
title: Deploy, status, logs and stop from the CLI
depends_on: ["004", "005"]
verify: pnpm verify
features:
  reads:
    - deployments
    - app-state
    - container-runtime
---
## Goal

Users drive deployments from the CLI with live progress (`paas deploy`, `paas stop`) and inspect them (`paas status`, `paas logs`). Commands get the container runtime from one factory that `buildProgram` takes. The default factory fails with `no container runtime is configured yet` until `docker-podman-adapter` replaces it. Tests inject one shared `FakeRuntime` and one `FakeClock`. `paas status` reads only the state store, so it works without a runtime.

## Verify

`pnpm verify`

It typechecks and runs every unit test offline, including the new commands in-process against a shared fake runtime, a fake clock and a temporary `PAAS_HOME`, and child-process runs showing the no-runtime failure and a runtime-free `paas status`. After each task it must pass.

## Non-goals

- A real runtime.
- Following logs as they are written.
- Live container state in `paas status`; `reconcile` adds the drift check.
- A CLI flag for the health window.
- Changing `deployments`, `app-state` or `container-runtime`.

## Surface

- Added: `paas deploy <app>` with `--image <ref>`, `--json`
- Added: `paas status [app]` with `--json`
- Added: `paas logs <app>` with `--tail <n>`, `--since <duration>`, `--json`
- Added: `paas stop <app>`
- Added: `no container runtime is configured yet` (error message of the default runtime factory)

## Contract

The full contract is the `cli` delta in `specs/cli/spec.md`. In short:

### Requirement: Runtime factory

Commands that need a runtime SHALL get it from the program's factory; the default fails with `no container runtime is configured yet`.

#### Scenario: No runtime yet
- **WHEN** app `web` exists and a user runs `paas deploy web` with the default factory
- **THEN** stderr is exactly `paas: no container runtime is configured yet` and a newline, the exit code is 1, and no deployment is created

### Requirement: Failed deploy output

A failed deploy SHALL print the error's further lines to stdout as `  | <line>` and one `paas: deployment <id> failed: <first line>` line to stderr, and exit 1.

#### Scenario: Health failure
- **WHEN** the new container writes log lines and exits with code 3 inside the health window
- **THEN** stdout has `  | <line>` for each of the last 20 log lines, stderr is exactly `paas: deployment <id> failed: container exited with code 3` and a newline, and the exit code is 1

### Requirement: Status overview

`paas status` SHALL read only the state store, with uptime measured from the time the deployment entered `running`.

#### Scenario: Works without a runtime
- **WHEN** a user runs `paas status` with the default runtime factory
- **THEN** it exits 0

## Human steps

- Review the proposal, the `cli` delta, and both task bodies.
- Run `osq approve 006-deploy-cli` yourself.

## Delta

- `specs/cli/spec.md`: adds the runtime factory, deploy, failed deploy output, deploy JSON, status overview, status JSON, status for one app, logs, and stop. Code ownership already covers `src/commands/**`.
- No file is shared between tasks. Task 1 owns `src/commands/context.ts` (changed additively; the frozen `tests/commands-helpers.test.ts` must keep passing) and the new `src/commands/deploy-helpers.ts`. Task 2 owns `src/program.ts` and the four new command files.
