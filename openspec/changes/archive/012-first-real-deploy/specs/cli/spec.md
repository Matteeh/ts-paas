# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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
