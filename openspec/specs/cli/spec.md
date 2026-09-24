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

### Requirement: Deploy command

`paas deploy <app>` SHALL run the deployment engine and print one line `<status>: <message>` per progress event as it happens, then `<app> is running (deployment <id>)`, and exit 0 when the deployment is running. When the ingress push fails, it SHALL instead exit 1 with stderr `paas: deployment <id> is running, but ingress update failed: <message>`. `--image <ref>` SHALL update the app's image first; the update stays even if the deploy then fails or is refused.

#### Scenario: Successful deploy
- **WHEN** app `web` is deployed on the fake runtime and the health window passes
- **THEN** stdout has lines starting `pending: `, `pulling: `, `starting: `, `running: ` in that order and ends with `web is running (deployment <id>)`, and the exit code is 0

#### Scenario: Redeploy shows replacement
- **WHEN** `web` is deployed while a previous deployment runs
- **THEN** stdout also has a line starting `replaced: `

#### Scenario: Ingress push fails
- **WHEN** ingress is up, `web` has a running deployment A, and the admin client rejects the push for new deployment B
- **THEN** stderr is `paas: deployment <B> is running, but ingress update failed: <message>` and a newline, the exit code is 1, and A is still `running`

### Requirement: Failed deploy output

When the deployment fails, `paas deploy` SHALL print each further line of the deployment error, such as the container's last log lines, to stdout as `  | <line>`, then exit 1 with stderr exactly `paas: deployment <id> failed: <first line of the error>`. A refused deploy SHALL be an operation failure with the engine's message.

#### Scenario: Health failure
- **WHEN** the new container writes log lines and exits with code 3 inside the health window
- **THEN** stdout has `  | <line>` for each of the last 20 log lines, stderr is exactly `paas: deployment <id> failed: container exited with code 3` and a newline, and the exit code is 1

### Requirement: Deploy JSON

`paas deploy --json` SHALL print no progress lines and exactly one JSON line with the final deployment record, `{id, app, image, status, containerId, error, createdAt, finishedAt}`. It SHALL exit 0 when running and 1 when failed, printing the same stderr line as the human form. When the ingress push fails, it SHALL print the running record and exit 1 with the same stderr line as the human form.

#### Scenario: JSON failure
- **WHEN** `paas deploy web --json` fails its health window
- **THEN** stdout is one JSON line whose `status` is `failed`, and the exit code is 1

### Requirement: Status overview

`paas status` SHALL print, from the state store, a table `APP STATUS CONTAINER IMAGE UPTIME`, one row per app ordered by name. Columns: the latest deployment's status, its container id cut to 12 characters, its image or else the app's image, and, when running, the time since it entered `running` as `45s`, `3m 20s`, `2h 5m` or `4d 3h`. Missing values print `-`. With no apps it SHALL print `no apps`.

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

`paas stop <app>` SHALL stop the app through the engine and print `stopped <app> (deployment <id>)`. An app without a running deployment SHALL be an operation failure with the engine's message. When the ingress push after stopping fails, it SHALL exit 1 with stderr `paas: <app> is stopped, but ingress update failed: <message>`.

#### Scenario: Stop twice
- **WHEN** `web` is stopped and then stopped again
- **THEN** the first exits 0 and the second exits 1 with stderr `paas: app "web" has no running deployment` and a newline

### Requirement: Default container runtime

Commands that need a container runtime SHALL get it from the one runtime factory the program is built with, and SHALL ping it before they open the state database. The default factory SHALL be the Docker adapter on the resolved socket. An unresolvable or unreachable engine SHALL be an operation failure with the adapter's message, leaving state untouched. Tests SHALL inject a fake runtime and a shared clock.

#### Scenario: Unreachable engine
- **WHEN** app `web` exists, `PAAS_SOCKET` names a missing path, and a user runs `paas deploy web`
- **THEN** stderr is exactly `paas: cannot reach container engine at <path>: socket not found` and a newline, the exit code is 1, and no deployment is created

### Requirement: Doctor command

`paas doctor` SHALL print lines `socket:`, `engine:` (name and version), `api:`, and `paas-net:` (`present` or `missing`), each label padded to 10 characters, with `-` for an unknown value. It SHALL not create the network or open the state database. `--json` SHALL print `{socket, engine, version, apiVersion, paasNet}`. An unresolvable or unreachable engine SHALL exit 1 with the adapter's message.

#### Scenario: Doctor on the fake
- **WHEN** `paas doctor` runs on the fake runtime without `paas-net`
- **THEN** stdout is `socket:   -`, `engine:   fake 0.0.0`, `api:      -`, `paas-net: missing`, and the exit code is 0

#### Scenario: Engine unreachable
- **WHEN** `PAAS_SOCKET` names a missing path and a user runs `paas doctor`
- **THEN** stderr is `paas: cannot reach container engine at <path>: socket not found` and a newline, and the exit code is 1

### Requirement: Ingress command group

`paas ingress` SHALL group the subcommands `up`, `down` and `status`, each with a one-line description, and without a subcommand SHALL print the group's help to stderr and exit 2. Each subcommand SHALL get its runtime from the program's runtime factory and its Caddy admin client from one admin factory the program is built with, defaulting to `http://127.0.0.1:2019`. Tests SHALL inject a fake admin client.

#### Scenario: Bare ingress
- **WHEN** a user runs `paas ingress`
- **THEN** stderr contains `Usage: paas ingress`, `up`, `down` and `status`, and the exit code is 2

### Requirement: Ingress up command

`paas ingress up` SHALL accept `--tls <off|auto>`, `--http-port <n>` and `--https-port <n>`, store the values given, keep stored values for flags left out, bring ingress up, and print `ingress is up (<action>): http <port>, https <port>, tls <mode>, routes <n>`. An invalid value SHALL be a usage error that changes no settings and touches no container.

#### Scenario: Up with defaults
- **WHEN** a user runs `paas ingress up` on the fake runtime with no apps
- **THEN** stdout is `ingress is up (created): http 80, https 443, tls off, routes 0` and the exit code is 0

#### Scenario: Bad TLS mode
- **WHEN** a user runs `paas ingress up --tls on`
- **THEN** stderr starts with `paas: `, the exit code is 2, and no container named `paas-caddy` exists

### Requirement: Ingress down command

`paas ingress down` SHALL bring ingress down and print `removed paas-caddy; kept volume paas-caddy-data`, or `paas-caddy does not exist` when there was nothing to remove. Both SHALL exit 0.

#### Scenario: Down twice
- **WHEN** ingress is up and a user runs `paas ingress down` twice
- **THEN** the first prints `removed paas-caddy; kept volume paas-caddy-data`, the second prints `paas-caddy does not exist`, and both exit 0

### Requirement: Ingress status command

`paas ingress status` SHALL print lines `caddy:`, `tls:`, `http:`, `https:` and `routes:` (the route count, or `-` when Caddy is not running), each label padded to 10 characters, then one `  <hostname> -> <upstream>` line per route. `--json` SHALL print `{caddy, tls, httpPort, httpsPort, routes}`, with `routes` an array of `{hostname, upstream}`, or `null` when Caddy is not running.

#### Scenario: Status without Caddy
- **WHEN** a user runs `paas ingress status` on the fake runtime before ingress is up
- **THEN** stdout is `caddy:    missing`, `tls:      off`, `http:     80`, `https:    443`, `routes:   -`, and the exit code is 0

### Requirement: Ingress follows deploys and stops

`paas deploy` SHALL push the ingress config through `syncIngress` as the engine's `onRunning` hook, and `paas stop` SHALL push it after the app is stopped. When `paas-caddy` is missing or not running, both SHALL behave as they did without ingress.

#### Scenario: Redeploy never routes to a removed container
- **WHEN** ingress is up and app `web` with a hostname is deployed and then redeployed
- **THEN** every config the admin client received routes `web`'s hostname only to a container that was running at that moment

### Requirement: Reconcile command

`paas reconcile` SHALL plan with `planReconcile`, apply the plan with `applyReconcile`, pruning orphans only with `--prune`, redeploy with `--redeploy`, push the ingress config, and print one line per item. `--dry-run` SHALL take no action and first print `dry run: nothing was changed`. It SHALL exit 1 when any item failed, and 0 otherwise, including when there is nothing to do.

#### Scenario: Nothing to do
- **WHEN** every running deployment's container runs and there are no orphans
- **THEN** stdout is `nothing to reconcile` and the exit code is 0

#### Scenario: Dry run changes nothing
- **WHEN** `web`'s container disappeared and a user runs `paas reconcile --dry-run --prune --redeploy`
- **THEN** stdout starts with `dry run: nothing was changed`, lists the `fail` and `redeploy` items as planned, the deployment is still `running`, and the exit code is 0

#### Scenario: Container disappeared
- **WHEN** `web`'s container disappeared and a user runs `paas reconcile`
- **THEN** stdout is `fail: web deployment <id> (container disappeared)`, the deployment is `failed`, and the exit code is 0

### Requirement: Reconcile output

Each item SHALL print as `<kind>: <subject> (<detail>)`: `fail: <app> deployment <id> (<error>)`, `orphan: <name> (app <app>; use --prune to remove)`, `prune: <name> (removed)`, `redeploy: <app> (deployment <id> is running)`, and `push-ingress: paas-caddy (<n> routes)`. A failed action's detail SHALL be `failed: <first line of message>`; a skipped one's in a dry run SHALL be `planned`. With no items it SHALL print `nothing to reconcile`.

#### Scenario: Orphan without prune
- **WHEN** container `web-old` of app `web` is an orphan and a user runs `paas reconcile`
- **THEN** stdout is `orphan: web-old (app web; use --prune to remove)` and the container still exists

#### Scenario: Prune fails
- **WHEN** removing orphan `web-old` fails with `device busy` under `--prune`
- **THEN** stdout has `prune: web-old (failed: device busy)` and the exit code is 1

### Requirement: Reconcile JSON

`paas reconcile --json` SHALL print `{dryRun, items}`, each item `{kind, app, deploymentId, containerId, detail, ok}` with `null` for values an item lacks. `ok` SHALL be `true` for a done action, `false` for a failed one, and `null` for a planned action or a reported orphan.

#### Scenario: JSON dry run
- **WHEN** `web`'s container disappeared and a user runs `paas reconcile --dry-run --json`
- **THEN** stdout is one JSON line with `dryRun` `true` and one item of kind `fail` whose `detail` is `container disappeared` and whose `ok` is `null`

### Requirement: Reconcile redeploy and ingress

With `--redeploy`, reconcile SHALL deploy again, one at a time in app name order, every app with no running deployment left whose latest deployment reached `running` and was then marked `failed`, whether this run or an earlier one failed it. It SHALL then push the ingress config with `syncIngress` when `paas-caddy` runs and an item changed something or Caddy's routes differ from `desiredRoutes`. A stuck deployment SHALL not cause a redeploy.

#### Scenario: Redeploy a lost container
- **WHEN** `web`'s container disappeared and a user runs `paas reconcile --redeploy` while the health window passes
- **THEN** stdout has the `fail` line, then `redeploy: web (deployment <new id> is running)`, and the exit code is 0

#### Scenario: Failed by an earlier run
- **WHEN** a plain `paas reconcile` failed `web` because its container disappeared, and a user then runs `paas reconcile --redeploy`
- **THEN** stdout is `redeploy: web (deployment <new id> is running)` and `web` has a running deployment

#### Scenario: Health failure is not redeployed
- **WHEN** `web`'s latest deployment failed its health window and it has no running deployment
- **THEN** `paas reconcile --redeploy` prints `nothing to reconcile`

#### Scenario: Caddy lost its routes
- **WHEN** ingress is up, `web` with hostname `web.localhost` runs, and Caddy's live config has no routes
- **THEN** `paas reconcile` prints `push-ingress: paas-caddy (1 routes)` and Caddy's config routes `web.localhost` again

#### Scenario: Stuck deployment is not redeployed
- **WHEN** `web`'s only deployment is stuck in `pulling` and a user runs `paas reconcile --redeploy`
- **THEN** stdout has a `fail` line for it and no `redeploy` line

### Requirement: Drift warning

After their normal output, `paas status` and `paas status <app>` SHALL ask for a dry-run reconcile plan without prune or redeploy. When it has items, they SHALL print `paas: warning: state and engine disagree on <n> item(s); run paas reconcile --dry-run` to stderr. When the engine cannot be reached or the check fails, they SHALL print nothing extra. The warning SHALL not change stdout or the exit code.

#### Scenario: Drift warns
- **WHEN** `web`'s running deployment's container disappeared and a user runs `paas status --json`
- **THEN** stdout is the usual JSON, stderr is `paas: warning: state and engine disagree on 1 item(s); run paas reconcile --dry-run` and a newline, and the exit code is 0

#### Scenario: Unreachable engine
- **WHEN** `PAAS_SOCKET` names a missing path and a user runs `paas status`
- **THEN** stderr is empty and the exit code is 0

### Requirement: Up command

`paas up` SHALL accept the flags of `paas ingress up`, ping the engine, ensure `paas-net`, and bring ingress up. It SHALL print the four `paas doctor` lines, then the `paas ingress up` line, then `next: paas apps create <name> --image <ref> --port <n> --host <name>.localhost`. An unreachable engine SHALL fail as it does for `paas doctor`, before any state changes. An invalid flag SHALL be a usage error.

#### Scenario: Fresh machine
- **WHEN** a user runs `paas up` on the fake runtime without `paas-net` or `paas-caddy`
- **THEN** stdout is `socket:   -`, `engine:   fake 0.0.0`, `api:      -`, `paas-net: present`, `ingress is up (created): http 80, https 443, tls off, routes 0`, and the `next:` line, and the exit code is 0

#### Scenario: Up twice
- **WHEN** a user runs `paas up` twice
- **THEN** the second run's ingress line says `(unchanged)`

#### Scenario: Unreachable engine
- **WHEN** `PAAS_SOCKET` names a missing path and a user runs `paas up`
- **THEN** stderr is `paas: cannot reach container engine at <path>: socket not found` and a newline, and the exit code is 1

### Requirement: End-to-end tier

`pnpm test:e2e` SHALL run `tests/e2e/*.e2e.ts` only when `PAAS_E2E=1`, and otherwise report skipped tests and exit 0. It SHALL drive the CLI in-process against the engine that socket resolution finds, with a runtime that labels everything it creates `paas.test=e2e`, and remove all of that afterwards, even on failure. It SHALL refuse to start when a container named `paas-caddy` already exists.

#### Scenario: Skipped without the variable
- **WHEN** `pnpm test:e2e` runs without `PAAS_E2E=1`
- **THEN** it reports one skipped test and exits 0

#### Scenario: The first real deploy
- **WHEN** it runs with `PAAS_E2E=1`
- **THEN** `paas up`, then creating and deploying `whoami.localhost` from `docker.io/traefik/whoami:v1.11.0`, serve it through Caddy; a redeploy with a changed environment variable serves the new value with every request during the redeploy answered 200; `paas logs`, `paas stop` and `paas ingress down` succeed

### Requirement: Reconcile starts a stopped Caddy

When `paas-caddy` exists but is not running, `paas reconcile` SHALL bring it up with `ingressUp`, which starts it and pushes the config, and SHALL report one item of kind `start-ingress`: `start-ingress: paas-caddy (started, <n> routes)`, or `failed: <message>` as its detail. It SHALL then add no `push-ingress` item. A dry run SHALL plan it, and `paas status` SHALL count it in its drift warning.

#### Scenario: Caddy crashed
- **WHEN** ingress was up, `web` with hostname `web.localhost` runs, and `paas-caddy` has exited
- **THEN** `paas reconcile` prints `start-ingress: paas-caddy (started, 1 routes)`, `paas-caddy` runs, and its config routes `web.localhost`

#### Scenario: Dry run
- **WHEN** `paas-caddy` has exited and a user runs `paas reconcile --dry-run`
- **THEN** stdout has `start-ingress: paas-caddy (planned)` and `paas-caddy` stays exited

#### Scenario: Status warns
- **WHEN** `paas-caddy` has exited and everything else agrees
- **THEN** `paas status` prints `paas: warning: state and engine disagree on 1 item(s); run paas reconcile --dry-run` to stderr

#### Scenario: Ingress brought down on purpose
- **WHEN** no `paas-caddy` exists
- **THEN** `paas reconcile` adds no `start-ingress` item

### Requirement: Busy host port message

When a command fails with `PortInUseError`, stderr SHALL be the one line `paas: host port <address> is already in use; find what holds it with "ss -ltnp | grep :<port>" (on rootless Podman a leftover containers-rootlessport process can hold it; see docs/manual-testing.md)`, and the exit code SHALL be 1. With no address, it SHALL say `a host port is already in use (<first line of the engine message>)` and drop the `grep`. A failed `start-ingress` item SHALL use the same text as its detail.

#### Scenario: paas up on a busy port
- **WHEN** starting the new `paas-caddy` fails with `PortInUseError` for `127.0.0.1:2019`
- **THEN** `paas up` exits 1, stderr starts `paas: host port 127.0.0.1:2019 is already in use; find what holds it with "ss -ltnp | grep :2019"`, and no `paas-caddy` exists
