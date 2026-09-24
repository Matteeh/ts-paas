# Spec Delta

## Purpose

The `app-state` capability is paas's local memory: a SQLite database, opened through `node:sqlite`, that stores apps and their deployments, evolves through numbered migrations, and is reached only through a small validating repository API.

## ADDED Requirements

### Requirement: Database location

The state database SHALL live at `$PAAS_HOME/state.db` when `PAAS_HOME` is set and non-empty, and at `~/.paas/state.db` otherwise. Opening a file database SHALL create it and any missing parent directories. Tests SHALL be able to open an in-memory database with the path `:memory:`.

#### Scenario: PAAS_HOME wins
- **WHEN** `PAAS_HOME` is `/tmp/p`
- **THEN** the state database path is `/tmp/p/state.db`

#### Scenario: Default location
- **WHEN** `PAAS_HOME` is unset or empty
- **THEN** the state database path is `.paas/state.db` under the user's home directory

#### Scenario: Created on first use
- **WHEN** the store opens a path whose parent directories do not exist
- **THEN** the directories and the database file are created

### Requirement: Migrations

Opening a database SHALL apply every numbered migration it has not yet applied, in order, each in its own transaction, and record each version with the time it was applied in the `schema_migrations` table. A migration that fails SHALL leave no trace of itself and the open SHALL fail. Opening a database whose recorded version is newer than the newest migration the code knows SHALL fail with `SchemaTooNewError`.

#### Scenario: Migrations apply once
- **WHEN** a file database is opened, closed, and opened again
- **THEN** each migration version appears exactly once in `schema_migrations`

#### Scenario: Failed migration rolls back
- **WHEN** a migration's second statement fails
- **THEN** opening fails, the migration's first statement has no effect, and its version is not recorded

#### Scenario: Newer database is refused
- **WHEN** a database records schema version 99 and the code knows fewer
- **THEN** opening it fails with `SchemaTooNewError` and the message `state database schema version 99 is newer than this paas supports (<supported>); upgrade paas`, where `<supported>` is the newest known version

### Requirement: No warnings on open

Opening the store SHALL write nothing to stderr.

#### Scenario: Silent open
- **WHEN** a child process opens and closes a file database through the store
- **THEN** its stderr is empty

### Requirement: SQL stays in the store

All SQL SHALL live under `src/state/`. Code outside it SHALL use the repository functions.

#### Scenario: No SQL outside the store
- **WHEN** another capability needs stored apps or deployments
- **THEN** it calls the functions exported from `src/state/`

### Requirement: Injected time and ids

The store SHALL take its clock and its deployment id generator when it opens, defaulting to the system clock and 12 random lowercase hex characters. Every stored timestamp SHALL be the clock's time as an ISO 8601 UTC string, as `Date.prototype.toISOString` produces.

#### Scenario: Deterministic timestamps
- **WHEN** the store is opened with a `FakeClock` at `2026-01-01T00:00:00.000Z` and an app is created
- **THEN** the app's `createdAt` and `updatedAt` are `2026-01-01T00:00:00.000Z`

### Requirement: Validation

The repository SHALL validate its input and reject invalid input with `ValidationError`, whose `field` names the field:
- `name`: 1 to 40 characters of lowercase letters, digits and hyphens, starting with a letter.
- `image`: non-empty, without whitespace.
- `port`: an integer from 1 to 65535.
- `hostname`: a valid DNS name, as the next requirement defines.
- `env`: every key matches `[A-Za-z_][A-Za-z0-9_]*`; values are any string.

#### Scenario: Invalid name names the field
- **WHEN** an app is created with name `Web`
- **THEN** it fails with `ValidationError` whose `field` is `name`

### Requirement: Hostnames

A valid hostname SHALL be at most 253 characters of dot-separated labels, each 1 to 63 letters, digits or hyphens, none starting or ending with a hyphen, with no trailing dot. The repository SHALL store hostnames lowercased.

#### Scenario: Hostname is normalized
- **WHEN** an app is created with hostname `Whoami.Localhost`
- **THEN** it is stored as `whoami.localhost`

### Requirement: Apps

An app SHALL have a name, an image reference, an internal port, an optional hostname, environment variables, and created and updated timestamps. The repository SHALL create, read, list (ordered by name), update, and delete apps. Creating an app whose name exists SHALL fail with `AppExistsError`. Giving an app a hostname another app has SHALL fail with `HostnameInUseError`. Reading, updating or deleting an unknown app SHALL fail with `AppNotFoundError`.

#### Scenario: Duplicate app
- **WHEN** an app named `web` exists and another app named `web` is created
- **THEN** it fails with `AppExistsError`

#### Scenario: Hostnames are unique
- **WHEN** app `a` has hostname `x.localhost` and app `b` is created or updated with hostname `x.localhost`
- **THEN** it fails with `HostnameInUseError`

### Requirement: Updating an app

An update SHALL change only the fields it names, SHALL replace the environment as a whole when it names it, SHALL clear the hostname when given `null`, and SHALL set the updated timestamp.

#### Scenario: Environment is replaced whole
- **WHEN** app `web` with env `{A: "1", B: "2"}` is updated with env `{A: "3"}`
- **THEN** its env is exactly `{A: "3"}`

#### Scenario: Partial update
- **WHEN** app `web` is updated with only a new port after the clock advanced
- **THEN** its port changes, its image, hostname and environment stay, and `updatedAt` is the clock's new time while `createdAt` is unchanged

### Requirement: Deleting an app

Deleting an app SHALL fail with `AppRunningError` while any of its deployments has status `running`; the message SHALL say to stop the app first. Otherwise deleting an app SHALL also delete its deployments and their status history.

#### Scenario: Running app cannot be deleted
- **WHEN** app `web` has a deployment with status `running` and `web` is deleted
- **THEN** it fails with `AppRunningError` and the app and deployment remain

#### Scenario: Delete removes history
- **WHEN** app `web` has only failed deployments and is deleted
- **THEN** the app, its deployments, and their status history are gone

### Requirement: Deployments

A deployment SHALL have an id, the app name, the image reference, a status, a container id, an error message, and created and finished timestamps. Status SHALL be one of `pending`, `pulling`, `starting`, `running`, `failed`, `stopped` or `replaced`. A new deployment SHALL start as `pending` with no container id, error, or finish time. Creating a deployment for an unknown app SHALL fail with `AppNotFoundError`. Reading an unknown deployment SHALL fail with `DeploymentNotFoundError`.

#### Scenario: New deployment
- **WHEN** a deployment is created for app `web` with image `nginx:1`
- **THEN** it has a generated id, status `pending`, and `null` container id, error and finish time

### Requirement: Status changes

The repository SHALL record every status change of a deployment with the clock's time, including the initial `pending`, and SHALL return a deployment's status changes oldest first. A status change SHALL optionally set the container id and the error message. Moving to `failed`, `stopped` or `replaced` SHALL set the finish time. A deployment in `failed`, `stopped` or `replaced` SHALL refuse any further status change with `DeploymentFinishedError`.

#### Scenario: Full history
- **WHEN** a deployment moves pending → pulling → starting → running on a clock advancing one second per step
- **THEN** its status changes are those four statuses with times one second apart, and its finish time is `null`

#### Scenario: Failure finishes a deployment
- **WHEN** a starting deployment moves to `failed` with error `exited with code 3`
- **THEN** its error is `exited with code 3` and its finish time is the clock's time

#### Scenario: Finished deployments are final
- **WHEN** a failed deployment is moved to `running`
- **THEN** it fails with `DeploymentFinishedError` and the deployment is unchanged

### Requirement: Latest deployment and history

The repository SHALL return an app's latest deployment, meaning the most recently created one, or `null` when it has none, and its deployment history newest first with an optional limit. Order SHALL follow creation order, even when deployments share a timestamp.

#### Scenario: Latest with equal timestamps
- **WHEN** two deployments of `web` are created without the clock moving
- **THEN** the latest deployment is the second one, and the history lists the second before the first

### Requirement: Code ownership
<!-- source: src/state/** -->
The app-state capability SHALL own the state database location, connection and migrations, validation, the store errors, and the app and deployment repositories.

#### Scenario: Codebase ownership boundaries
- **WHEN** file ownership is resolved for app-state
- **THEN** system maps `src/state/**` to app-state
