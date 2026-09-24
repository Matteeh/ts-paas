---
title: App management CLI
depends_on: ["003"]
verify: pnpm verify
features:
  reads:
    - app-state
---
## Goal

Users create, list, inspect, change and delete apps from the CLI through `paas apps`. The commands sit on the `app-state` repository and follow the `cli` output, error and exit-code conventions. Nothing runs yet. The change also fixes two things later CLI changes reuse: commands get their environment (and so `PAAS_HOME`) from `buildProgram`, and validation errors print the failing subcommand's usage and exit 2.

## Verify

`pnpm verify`

It typechecks and runs every unit test offline, including the apps commands run in-process against a temporary `PAAS_HOME` and one child-process run of `paas apps list`. After each task it must pass.

## Non-goals

- Deploying, stopping, or anything that touches containers.
- Reading environment variables from files.
- Changing `app-state`. The commands use its exported functions and errors as they are.
- Fixing the flaky `systemClock` timing test in `tests/clock.test.ts` (owned by `container-runtime`).

## Surface

- Added: `paas apps` (command group; bare, prints its help and exits 2)
- Added: `paas apps create <name>` with `--image <ref>`, `--port <n>`, `--host <hostname>`, `--env KEY=VALUE` (repeatable), `--json`
- Added: `paas apps list` with `--json`
- Added: `paas apps show <name>` with `--reveal`, `--json`
- Added: `paas apps set <name>` with `--image`, `--port`, `--host`, `--unset-host`, `--env KEY=VALUE`, `--unset-env KEY` (both repeatable), `--json`
- Added: `paas apps delete <name>`
- Changed: validation errors from the store are usage errors (exit 2, failing subcommand's usage on stderr)

## Contract

The full contract is the `cli` delta in `specs/cli/spec.md`. In short:

### Requirement: Validation errors are usage errors

A store `ValidationError` or an unparseable flag value SHALL print `paas: <message>` and the failing command's usage to stderr and exit 2.

#### Scenario: Invalid port
- **WHEN** a user runs `paas apps create web --image nginx:1 --port 0`
- **THEN** stderr starts with `paas: invalid port 0`, then contains `Usage: paas apps create`, stdout is empty, and the exit code is 2

### Requirement: Masked environment values

Environment values SHALL print as `******` unless `show` is given `--reveal`.

#### Scenario: Masked by default
- **WHEN** app `web` has env `{TOKEN: "s3cret"}` and a user runs `paas apps show web --json`
- **THEN** the JSON `env` is `{"TOKEN":"******"}` and stdout does not contain `s3cret`

### Requirement: Deleting an app from the CLI

Deleting an app with a running deployment SHALL fail with exit 1 and a message to stop the app first.

#### Scenario: Running app
- **WHEN** app `web` has a running deployment and a user runs `paas apps delete web`
- **THEN** stderr is `paas: app "web" has a running deployment; stop the app first` and a newline, the exit code is 1, and `web` still exists

## Human steps

- Review the proposal, the `cli` delta, and both task bodies.
- Run `osq approve 004-app-management-cli` yourself.

## Delta

- `specs/cli/spec.md`: adds the program environment, validation-as-usage errors, the `apps` group and its five subcommands, and masking; modifies Code ownership to add `src/commands/**`.
- No file is shared between tasks. Task 1 owns the shared helpers (`src/commands/context.ts`, `src/commands/format.ts`). Task 2 owns `src/program.ts`, the registration file `src/commands/apps.ts`, and all five subcommand files, because the registration file must import every subcommand and each task's verify runs through the real program.
