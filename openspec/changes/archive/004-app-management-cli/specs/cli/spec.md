# Spec Delta

## ADDED Requirements

### Requirement: Commands use the program's environment

`buildProgram` SHALL accept an environment, defaulting to `process.env`. Commands that need stored state SHALL open the state database at the path `app-state` resolves from that environment's `PAAS_HOME`, once per command, and SHALL close it before the command returns, whether or not it failed.

#### Scenario: PAAS_HOME from the program's environment
- **WHEN** the program is built with `PAAS_HOME` set to a temporary directory and runs `paas apps create web --image nginx:1 --port 80`
- **THEN** `state.db` in that directory holds app `web`

### Requirement: Validation errors are usage errors

When a command's input fails validation, either as a store `ValidationError` or as a flag value the command cannot parse, `paas` SHALL treat it as a usage error. stderr SHALL get `paas: <message>` and then the usage of the command that failed, stdout SHALL get nothing, and the exit code SHALL be 2. Other store errors SHALL be operation failures.

#### Scenario: Invalid port
- **WHEN** a user runs `paas apps create web --image nginx:1 --port 0`
- **THEN** stderr starts with `paas: invalid port 0`, then contains `Usage: paas apps create`, stdout is empty, and the exit code is 2

#### Scenario: Unparseable port
- **WHEN** a user runs `paas apps create web --image nginx:1 --port abc`
- **THEN** stderr starts with `paas: invalid port "abc"` and the exit code is 2

### Requirement: Apps command group

`paas apps` SHALL group the subcommands `create`, `list`, `show`, `set` and `delete`, each with a one-line description. `paas apps` without a subcommand SHALL print the group's help to stderr and exit 2.

#### Scenario: Bare apps
- **WHEN** a user runs `paas apps`
- **THEN** stderr contains `Usage: paas apps` and every subcommand name, and the exit code is 2

### Requirement: Showing an app

An app SHALL print as lines of a label padded to 9 characters followed by the value, in the order `name:`, `image:`, `port:`, `host:`, `status:` (the latest deployment's status), `created:`, `updated:`, then `env:` and one `  KEY=VALUE` line per variable sorted by key. A missing host, status or environment SHALL print as `-`. `--json` SHALL print the object `{name, image, port, hostname, status, env, createdAt, updatedAt}`.

#### Scenario: Human form
- **WHEN** app `web` has image `nginx:1`, port 80, no host, no deployment, and env `{B: "2", A: "1"}`
- **THEN** `paas apps show web --reveal` prints `name:    web`, `image:   nginx:1`, `port:    80`, `host:    -`, `status:  -`, the two time lines, `env:`, `  A=1`, `  B=2`

### Requirement: Masked environment values

`paas apps show`, `create` and `set` SHALL print every environment value as `******` in both forms, unless `show` is given `--reveal`. Variable names SHALL always print.

#### Scenario: Masked by default
- **WHEN** app `web` has env `{TOKEN: "s3cret"}` and a user runs `paas apps show web --json`
- **THEN** the JSON `env` is `{"TOKEN":"******"}` and stdout does not contain `s3cret`

#### Scenario: Reveal
- **WHEN** a user runs `paas apps show web --json --reveal`
- **THEN** the JSON `env` is `{"TOKEN":"s3cret"}`

### Requirement: Creating an app

`paas apps create <name> --image <ref> --port <n>` SHALL create an app, with optional `--host <hostname>` and repeatable `--env KEY=VALUE`, split at the first `=`, the later value winning for a repeated key. It SHALL then print the app as `show` does, masked, accepting `--json`. A value without `=` or with an empty key SHALL be a usage error. An existing name SHALL be an operation failure.

#### Scenario: Create with env
- **WHEN** a user runs `paas apps create web --image nginx:1 --port 80 --env A=x=y --env A=z`
- **THEN** the stored env is `{A: "z"}`, the exit code is 0, and stdout shows `  A=******`

#### Scenario: Existing app
- **WHEN** app `web` exists and a user runs `paas apps create web --image nginx:1 --port 80`
- **THEN** stderr is exactly `paas: app "web" already exists` and a newline, and the exit code is 1

### Requirement: Listing apps

`paas apps list` SHALL print a table with the header `NAME IMAGE PORT HOST STATUS` and one row per app ordered by name, columns left-aligned and separated by two spaces, no trailing spaces, and `-` for a missing host or status. With no apps it SHALL print `no apps`. `--json` SHALL print an array of `{name, image, port, hostname, status, createdAt, updatedAt}`, empty when there are no apps.

#### Scenario: Status column
- **WHEN** app `web` has a latest deployment with status `running` and app `api` has none
- **THEN** the `api` row comes first with status `-`, and the `web` row has status `running`

### Requirement: Changing an app

`paas apps set <name>` SHALL accept `--image`, `--port`, `--host`, `--unset-host`, repeatable `--env KEY=VALUE` that adds or replaces variables, and repeatable `--unset-env KEY` that removes them, ignoring keys that are not set. It SHALL print the app as `create` does. No flag, `--host` with `--unset-host`, or one key in both `--env` and `--unset-env` SHALL be a usage error.

#### Scenario: Merge env
- **WHEN** app `web` has env `{A: "1", B: "2"}` and a user runs `paas apps set web --env B=3 --env C=4 --unset-env A`
- **THEN** the stored env is `{B: "3", C: "4"}`

#### Scenario: Nothing to change
- **WHEN** a user runs `paas apps set web`
- **THEN** stderr starts with `paas: nothing to change` and the exit code is 2

### Requirement: Deleting an app from the CLI

`paas apps delete <name>` SHALL delete the app and print `deleted app <name>`. When the app has a running deployment it SHALL fail as an operation failure with the store's message, which says to stop the app first.

#### Scenario: Running app
- **WHEN** app `web` has a running deployment and a user runs `paas apps delete web`
- **THEN** stderr is `paas: app "web" has a running deployment; stop the app first` and a newline, the exit code is 1, and `web` still exists

## MODIFIED Requirements

### Requirement: Code ownership
<!-- source: src/cli.ts, src/program.ts, src/errors.ts, src/output.ts, src/version.ts, src/commands/** -->
The cli capability SHALL own the `paas` entry point, program construction and argument parsing, error types, the shared output helper, version lookup, and every command under `src/commands/`.

#### Scenario: Codebase ownership boundaries
- **WHEN** file ownership is resolved for cli
- **THEN** system maps `src/cli.ts`, `src/program.ts`, `src/errors.ts`, `src/output.ts`, `src/version.ts`, and `src/commands/**` to cli
