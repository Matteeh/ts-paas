# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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

### Requirement: Deploy JSON

`paas deploy --json` SHALL print no progress lines and exactly one JSON line with the final deployment record, `{id, app, image, status, containerId, error, createdAt, finishedAt}`. It SHALL exit 0 when running and 1 when failed, printing the same stderr line as the human form. When the ingress push fails, it SHALL print the running record and exit 1 with the same stderr line as the human form.

#### Scenario: JSON failure
- **WHEN** `paas deploy web --json` fails its health window
- **THEN** stdout is one JSON line whose `status` is `failed`, and the exit code is 1

### Requirement: Stop command

`paas stop <app>` SHALL stop the app through the engine and print `stopped <app> (deployment <id>)`. An app without a running deployment SHALL be an operation failure with the engine's message. When the ingress push after stopping fails, it SHALL exit 1 with stderr `paas: <app> is stopped, but ingress update failed: <message>`.

#### Scenario: Stop twice
- **WHEN** `web` is stopped and then stopped again
- **THEN** the first exits 0 and the second exits 1 with stderr `paas: app "web" has no running deployment` and a newline
