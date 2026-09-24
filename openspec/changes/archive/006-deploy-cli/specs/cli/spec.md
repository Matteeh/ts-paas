# Spec Delta

## ADDED Requirements

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
