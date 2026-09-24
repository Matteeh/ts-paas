# Spec Delta

## MODIFIED Requirements

### Requirement: Engine error mapping

The adapter SHALL map engine errors to typed errors, keeping the engine's message and the original error as `cause`. A socket that refuses, is missing, or denies access SHALL become `RuntimeUnavailableError` `cannot reach container engine at <socket>: <code>`. A 404 SHALL become `ImageNotFoundError` on pull and create, and `ContainerNotFoundError` elsewhere. On create only, a 409, or a 500 saying the name is already in use, SHALL become `NameConflictError`. A 304 on start or stop SHALL succeed.

#### Scenario: 409 on remove is not a name conflict
- **WHEN** the engine answers 409 to removing a running container without `force`
- **THEN** `removeContainer` fails with a `RuntimeError` that is not a `NameConflictError`

#### Scenario: Other 500 on create
- **WHEN** create fails with status 500 and a message that does not say the name is in use
- **THEN** `createContainer` fails with a `RuntimeError` that is not a `NameConflictError`

### Requirement: Docker and Podman differences

Where the engines differ, the adapter SHALL behave the same through the interface. A failed pull, as a 500 response or an error inside the pull stream, whose message says `manifest unknown`, `does not exist`, `access denied` or `access to the resource is denied` SHALL be `ImageNotFoundError`. Podman 3.4 reports name conflicts as 500. Docker's list can lag behind inspect. Podman names itself in its version components and requires fully qualified image references.

#### Scenario: Podman missing image
- **WHEN** a pull fails with status 500 and message `manifest unknown`
- **THEN** `pullImage` fails with `ImageNotFoundError`

#### Scenario: Missing image inside the pull stream
- **WHEN** the pull request succeeds and the stream ends with an error event `requested access to the resource is denied`
- **THEN** `pullImage` fails with `ImageNotFoundError`

#### Scenario: Podman 3.4 name conflict
- **WHEN** create fails with status 500 and a message ending `that name is already in use`
- **THEN** `createContainer` fails with `NameConflictError`

### Requirement: Integration tier

`pnpm test:integration` SHALL run the contract suite against the engine the socket resolution finds, only when `PAAS_INTEGRATION=1`, and otherwise report skipped tests and exit 0. The suite SHALL be labelled `<engine name> (<socket>)`. It SHALL use `registry.k8s.io/pause:3.10` as the present image, label everything it creates `paas.test=true`, and remove it all after each test, even on failure. Integration files SHALL be named `*.itest.ts`.

#### Scenario: Skipped without the variable
- **WHEN** `pnpm test:integration` runs without `PAAS_INTEGRATION=1`
- **THEN** it reports skipped tests and exits 0

#### Scenario: Suite names the engine
- **WHEN** the integration tier runs against rootless Podman on `/run/user/1000/podman/podman.sock`
- **THEN** the suite is named `container runtime contract: podman (/run/user/1000/podman/podman.sock)`

## ADDED Requirements

### Requirement: List state matches inspection

The state `listContainers` reports for each container SHALL be the state `inspectContainer` would report at that moment. The Docker adapter SHALL take each listed container's state from inspecting it, and SHALL leave out a container that disappears between listing and inspecting.

#### Scenario: Stopped container in a lagging list
- **WHEN** the engine's list still reports a just-stopped container as `running` but inspecting it reports `exited`
- **THEN** `listContainers` reports it as `exited`

#### Scenario: Container removed while listing
- **WHEN** a listed container's inspect answers 404
- **THEN** `listContainers` leaves it out and does not fail
