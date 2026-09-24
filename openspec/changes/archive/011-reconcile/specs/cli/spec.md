# Spec Delta

## ADDED Requirements

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

With `--redeploy`, reconcile SHALL deploy again, one at a time, each app it failed because its container was missing or not running and that has no running deployment left. It SHALL then push the ingress config with `syncIngress` when `paas-caddy` runs and an item changed something or Caddy's routes differ from `desiredRoutes`. A stuck deployment SHALL not cause a redeploy.

#### Scenario: Redeploy a lost container
- **WHEN** `web`'s container disappeared and a user runs `paas reconcile --redeploy` while the health window passes
- **THEN** stdout has the `fail` line, then `redeploy: web (deployment <new id> is running)`, and the exit code is 0

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

## MODIFIED Requirements

### Requirement: Status overview

`paas status` SHALL print, from the state store, a table `APP STATUS CONTAINER IMAGE UPTIME`, one row per app ordered by name. Columns: the latest deployment's status, its container id cut to 12 characters, its image or else the app's image, and, when running, the time since it entered `running` as `45s`, `3m 20s`, `2h 5m` or `4d 3h`. Missing values print `-`. With no apps it SHALL print `no apps`.

#### Scenario: Uptime from the store
- **WHEN** `web`'s deployment entered `running` and the clock then advances 125 seconds
- **THEN** the `web` row's uptime is `2m 5s`

#### Scenario: Works without a runtime
- **WHEN** a user runs `paas status` with the default runtime factory
- **THEN** it exits 0
