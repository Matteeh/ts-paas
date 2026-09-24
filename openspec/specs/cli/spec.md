# cli Specification

## Purpose
The `cli` capability is the `paas` command-line entry point: how the package is built and installed, how arguments are parsed, and the output, error, and exit-code conventions every `paas` command follows.

## Requirements

### Requirement: Package and toolchain

The package SHALL be named `ts-paas`, be an ES module package, require Node 24 or later, and expose a `paas` binary that runs `dist/cli.js`. `pnpm verify` SHALL typecheck the project and run every unit test without network access, Docker, or a built `dist/`. `pnpm build` SHALL compile `src/` to `dist/`.

#### Scenario: Verify runs offline from source
- **WHEN** `pnpm verify` runs on a clean checkout with dependencies installed and no `dist/`
- **THEN** it typechecks `src/` and `tests/`, runs every `tests/**/*.test.ts` file, and exits 0 when all pass

#### Scenario: Built binary runs from dist
- **WHEN** `pnpm build` runs and then `node dist/cli.js --version` runs
- **THEN** the version from `package.json` prints to stdout and the process exits 0

### Requirement: Version output

`paas --version` and `paas -V` SHALL print the `version` field of `package.json` followed by a newline to stdout and exit 0.

#### Scenario: Version matches package.json
- **WHEN** a user runs `paas --version`
- **THEN** stdout is exactly the `package.json` version and a newline, stderr is empty, and the exit code is 0

### Requirement: Help output

`paas --help`, `paas -h`, and `paas` with no arguments SHALL print usage to stdout and exit 0. The help SHALL list every registered command with its one-line description. Every registered command SHALL have a non-empty one-line description.

#### Scenario: Help lists usage and commands
- **WHEN** a user runs `paas --help`
- **THEN** stdout starts with `Usage: paas`, includes the name and description of every registered command, and the exit code is 0

#### Scenario: No arguments prints help
- **WHEN** a user runs `paas` with no arguments
- **THEN** stdout is the same help text as `paas --help` and the exit code is 0

#### Scenario: Every command is described
- **WHEN** the program's registered commands are listed
- **THEN** each has a description that is non-empty and a single line

### Requirement: Error format and exit codes

Every error SHALL print to stderr as one line starting with `paas: ` followed by the message. `paas` SHALL exit 0 on success, 1 when the operation failed, and 2 on a usage error. An unknown command, an unknown option, a missing or extra argument, or a thrown `UsageError` SHALL be a usage error: `paas: <message>` and then the usage text print to stderr, and nothing prints to stdout. Any other thrown error SHALL be an operation failure: only `paas: <message>` prints to stderr.

#### Scenario: Unknown command is a usage error
- **WHEN** a user runs `paas nope`
- **THEN** stderr starts with `paas: `, then contains the usage text, stdout is empty, and the exit code is 2

#### Scenario: Unknown option is a usage error
- **WHEN** a user runs `paas --bogus`
- **THEN** stderr starts with `paas: ` and mentions `--bogus`, then contains the usage text, stdout is empty, and the exit code is 2

#### Scenario: Operation failure exits 1
- **WHEN** a command action throws an error that is not a `UsageError`, with message `boom`
- **THEN** stderr is exactly `paas: boom` and a newline, and the exit code is 1

### Requirement: JSON output convention

Every command that prints data SHALL accept `--json`. With `--json`, the command SHALL print exactly one JSON value, serialized on a single line and followed by a newline, to stdout and nothing else to stdout. Without `--json`, the command SHALL print its human-readable form. Errors SHALL follow the error format and exit codes whether or not `--json` is given. Commands SHALL produce data output through the shared output helper in `src/output.ts`.

#### Scenario: JSON mode prints only JSON
- **WHEN** the output helper is given the value `{"a":1}` in JSON mode
- **THEN** stdout is exactly `{"a":1}` and a newline

#### Scenario: Human mode uses the formatter
- **WHEN** the output helper is given a value and a formatter in human mode
- **THEN** stdout is the formatter's text followed by one newline, and no JSON prints

### Requirement: Code ownership
<!-- source: src/cli.ts, src/program.ts, src/errors.ts, src/output.ts, src/version.ts, src/commands/** -->
The cli capability SHALL own the `paas` entry point, program construction and argument parsing, error types, the shared output helper, version lookup, and every command under `src/commands/`.

#### Scenario: Codebase ownership boundaries
- **WHEN** file ownership is resolved for cli
- **THEN** system maps `src/cli.ts`, `src/program.ts`, `src/errors.ts`, `src/output.ts`, `src/version.ts`, and `src/commands/**` to cli

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

### Requirement: Runtime factory

Commands that need a container runtime SHALL get it from the one runtime factory the program is built with, before they open the state database. The default factory SHALL fail with `no container runtime is configured yet` as an operation failure. Tests SHALL inject a factory that returns one shared fake runtime, and a clock that the store, the runtime and the engine share.

#### Scenario: No runtime yet
- **WHEN** app `web` exists and a user runs `paas deploy web` with the default factory
- **THEN** stderr is exactly `paas: no container runtime is configured yet` and a newline, the exit code is 1, and no deployment is created

### Requirement: Deploy command

`paas deploy <app>` SHALL run the deployment engine and print one line `<status>: <message>` per progress event as it happens, then `<app> is running (deployment <id>)`, and exit 0 when the deployment is running. `--image <ref>` SHALL update the app's image first; the update stays even if the deploy then fails or is refused.

#### Scenario: Successful deploy
- **WHEN** app `web` is deployed on the fake runtime and the health window passes
- **THEN** stdout has lines starting `pending: `, `pulling: `, `starting: `, `running: ` in that order and ends with `web is running (deployment <id>)`, and the exit code is 0

#### Scenario: Redeploy shows replacement
- **WHEN** `web` is deployed while a previous deployment runs
- **THEN** stdout also has a line starting `replaced: `

### Requirement: Failed deploy output

When the deployment fails, `paas deploy` SHALL print each further line of the deployment error, such as the container's last log lines, to stdout as `  | <line>`, then exit 1 with stderr exactly `paas: deployment <id> failed: <first line of the error>`. A refused deploy SHALL be an operation failure with the engine's message.

#### Scenario: Health failure
- **WHEN** the new container writes log lines and exits with code 3 inside the health window
- **THEN** stdout has `  | <line>` for each of the last 20 log lines, stderr is exactly `paas: deployment <id> failed: container exited with code 3` and a newline, and the exit code is 1

### Requirement: Deploy JSON

`paas deploy --json` SHALL print no progress lines and exactly one JSON line with the final deployment record, `{id, app, image, status, containerId, error, createdAt, finishedAt}`. It SHALL exit 0 when running and 1 when failed, printing the same stderr line as the human form.

#### Scenario: JSON failure
- **WHEN** `paas deploy web --json` fails its health window
- **THEN** stdout is one JSON line whose `status` is `failed`, and the exit code is 1

### Requirement: Status overview

`paas status` SHALL read only the state store and print a table `APP STATUS CONTAINER IMAGE UPTIME`, one row per app ordered by name. Columns: the latest deployment's status, its container id cut to 12 characters, its image or else the app's image, and, when running, the time since it entered `running` as `45s`, `3m 20s`, `2h 5m` or `4d 3h`. Missing values print `-`. With no apps it SHALL print `no apps`.

#### Scenario: Uptime from the store
- **WHEN** `web`'s deployment entered `running` and the clock then advances 125 seconds
- **THEN** the `web` row's uptime is `2m 5s`

#### Scenario: Works without a runtime
- **WHEN** a user runs `paas status` with the default runtime factory
- **THEN** it exits 0

### Requirement: Status JSON

`paas status --json` SHALL print an array of `{app, status, deploymentId, containerId, image, runningSince, uptimeSeconds}`, with `null` for missing values and the full container id. `paas status <app> --json` SHALL print that app's object with `deployments`, its last five deployment records newest first.

#### Scenario: JSON overview
- **WHEN** app `api` has no deployments and a user runs `paas status --json`
- **THEN** the `api` item has `status`, `deploymentId`, `containerId`, `runningSince` and `uptimeSeconds` all `null` and `image` equal to the app's image

### Requirement: Status for one app

`paas status <app>` SHALL print the app's overview row as a table, a blank line, and a table `ID STATUS IMAGE CREATED FINISHED ERROR` of its last five deployments newest first, with the first line of each error and `-` for missing values. An unknown app SHALL be an operation failure.

#### Scenario: Last five deployments
- **WHEN** app `web` has seven deployments and a user runs `paas status web`
- **THEN** the deployments table lists the five newest, newest first

### Requirement: Logs command

`paas logs <app>` SHALL print the running deployment's container logs, stdout entries to stdout and stderr entries to stderr, one line each. `--tail <n>` SHALL take a positive integer and `--since <duration>` a number followed by `s`, `m`, `h` or `d`; other values are usage errors. `--json` SHALL print an array of `{stream, time, text}`. An app without a running deployment SHALL be an operation failure.

#### Scenario: Stream routing
- **WHEN** the container wrote `out1` to stdout and `err1` to stderr
- **THEN** `paas logs web` writes `out1` to stdout and `err1` to stderr

#### Scenario: Bad duration
- **WHEN** a user runs `paas logs web --since 5x`
- **THEN** stderr starts with `paas: invalid duration "5x"` and the exit code is 2

### Requirement: Stop command

`paas stop <app>` SHALL stop the app through the engine and print `stopped <app> (deployment <id>)`. An app without a running deployment SHALL be an operation failure with the engine's message.

#### Scenario: Stop twice
- **WHEN** `web` is stopped and then stopped again
- **THEN** the first exits 0 and the second exits 1 with stderr `paas: app "web" has no running deployment` and a newline
