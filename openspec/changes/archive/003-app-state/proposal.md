---
title: App state store
depends_on: ["001", "002"]
verify: pnpm verify
features:
  reads:
    - container-runtime
---
## Goal

paas remembers apps and their deployments in a local SQLite database through `node:sqlite`, with numbered migrations and a small validating repository API. Tests run it against in-memory databases with an injected clock and id generator. `app-management-cli`, `deployment-engine`, `ingress-caddy` and `reconcile` all build on this API.

The store reuses the `Clock` from `container-runtime` (`src/clock.ts`), so this change depends on 002 as well as 001.

## Verify

`pnpm verify`

It typechecks `src/` and `tests/` and runs every unit test offline, including the store tests against in-memory and temporary-directory databases. After each task it must pass.

## Non-goals

- Postgres.
- Several processes writing at once. One CLI process at a time is the assumption until an API server exists.
- Any `paas` command. The `cli` capability is untouched.
- Suppressing a `node:sqlite` ExperimentalWarning. On Node 24.21 opening a database prints none, so the contract is only that opening the store writes nothing to stderr.
- Adding, removing, or upgrading dependencies.

## Surface

- Added: `PAAS_HOME` (environment variable; state directory, default `~/.paas`)
- Added: `$PAAS_HOME/state.db` (state database file)

## Contract

The full contract is the `app-state` delta in `specs/app-state/spec.md`. In short:

### Requirement: Migrations

Opening a database SHALL apply unapplied numbered migrations in order, each in a transaction, and SHALL refuse a newer database with `SchemaTooNewError`.

#### Scenario: Newer database is refused
- **WHEN** a database records schema version 99 and the code knows fewer
- **THEN** opening it fails with `SchemaTooNewError` naming 99 and the supported version

### Requirement: Validation

The repository SHALL reject invalid names, images, ports, hostnames and env keys with `ValidationError` naming the field.

#### Scenario: Invalid name names the field
- **WHEN** an app is created with name `Web`
- **THEN** it fails with `ValidationError` whose `field` is `name`

### Requirement: Deleting an app

Deleting an app with a running deployment SHALL fail with `AppRunningError`; otherwise its deployments go with it.

#### Scenario: Running app cannot be deleted
- **WHEN** app `web` has a deployment with status `running` and `web` is deleted
- **THEN** it fails with `AppRunningError` and the app and deployment remain

### Requirement: Status changes

Every status change SHALL be recorded with its time; `failed`, `stopped` and `replaced` SHALL set the finish time and be final.

#### Scenario: Finished deployments are final
- **WHEN** a failed deployment is moved to `running`
- **THEN** it fails with `DeploymentFinishedError` and the deployment is unchanged

## Human steps

- Review the proposal, the `app-state` delta, and the three task bodies.
- Run `osq approve 003-app-state` yourself.

## Delta

- `specs/app-state/spec.md`: new `app-state` capability (Purpose, location, migrations, silent open, SQL confinement, injected time and ids, validation, apps, deleting apps, deployments, status changes, latest and history, code ownership).
- No file is shared between tasks. Task 1 owns the connection, the whole v1 schema and the errors; task 2 owns validation and apps; task 3 owns deployments. Later tasks import earlier files and never edit them.
