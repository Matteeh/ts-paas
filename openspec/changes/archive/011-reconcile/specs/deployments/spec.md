# Spec Delta

## ADDED Requirements

### Requirement: Reconcile plan

`planReconcile` SHALL compare the store with the containers `listContainers({"paas.managed": "true"})` returns, on the injected clock, and SHALL change nothing. It SHALL return one item per deployment to fail, ordered by app name, then one per orphaned container, ordered by container name. An empty plan SHALL mean state and engine agree.

#### Scenario: In agreement
- **WHEN** `web`'s running deployment's container is running and no other app container exists
- **THEN** the plan is empty

### Requirement: Reconcile: container missing

A `running` deployment whose container id is `null` or matches no listed container SHALL be planned to fail with error `container disappeared`.

#### Scenario: Container removed by hand
- **WHEN** `web`'s running deployment's container was removed outside paas
- **THEN** the plan fails that deployment with error `container disappeared`

### Requirement: Reconcile: container not running

A `running` deployment whose container is listed but not `running` SHALL be planned to fail with error `container exited with code <n>`, taking the exit code from `inspectContainer`, or `container is not running` when there is no exit code.

#### Scenario: Container exited
- **WHEN** `web`'s running deployment's container has exited with code 137
- **THEN** the plan fails that deployment with error `container exited with code 137`

#### Scenario: Container created but never started
- **WHEN** `web`'s running deployment's container is in state `created`
- **THEN** the plan fails that deployment with error `container is not running`

### Requirement: Reconcile: stuck deployments

A deployment in `pending`, `pulling` or `starting` whose latest status change is more than the stuck threshold before the clock's time, ten minutes by default, SHALL be planned to fail with error `stuck in <status> since <time of that change>`.

#### Scenario: Stuck while pulling
- **WHEN** `web`'s deployment entered `pulling` and the clock then advanced 10 minutes and 1 ms
- **THEN** the plan fails it with error `stuck in pulling since <time it entered pulling>`

#### Scenario: At the threshold
- **WHEN** the clock advanced exactly 10 minutes since the deployment entered `pulling`
- **THEN** the plan does not include it

### Requirement: Reconcile: orphans

A listed container with a `paas.app` label SHALL be an orphan unless it is the container of a deployment that stays `running`, or stays in flight without being stuck, after the plan's failures. A container without a `paas.app` label, such as `paas-caddy`, SHALL never be an orphan.

#### Scenario: Previous container left behind
- **WHEN** a redeploy marked deployment A `replaced` but could not remove A's container
- **THEN** the plan reports A's container as an orphan of `web`

#### Scenario: Failed deployment's container
- **WHEN** the plan fails `web`'s running deployment because its container exited
- **THEN** the same plan reports that container as an orphan

#### Scenario: Deploy in flight
- **WHEN** a deployment entered `starting` one minute ago and its container is running
- **THEN** the container is not an orphan and the deployment is not in the plan

#### Scenario: Caddy is never an orphan
- **WHEN** `paas-caddy` runs with labels `paas.managed=true` and `paas.ingress=caddy`
- **THEN** it is not in the plan

### Requirement: Applying a reconcile plan

`applyReconcile` SHALL mark each planned failure `failed` with its error. With `prune` it SHALL force-remove each orphan, counting a container that is already gone as removed; without `prune` it SHALL leave orphans alone. It SHALL return one outcome per item: `done`, `failed` with the error message, or `reported` for an orphan it left alone. One failed removal SHALL not stop the rest.

#### Scenario: Prune
- **WHEN** a plan with one failure and two orphans is applied with `prune`, and removing the first orphan fails
- **THEN** the deployment is `failed`, the first orphan's outcome is `failed` with the runtime's message, and the second orphan is removed with outcome `done`

#### Scenario: Report only
- **WHEN** a plan with one orphan is applied without `prune`
- **THEN** the orphan still exists and its outcome is `reported`
