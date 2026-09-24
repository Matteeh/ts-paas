# Spec Delta

## MODIFIED Requirements

### Requirement: Runtime interface

paas SHALL reach an engine only through `ContainerRuntime` in `src/runtime/types.ts`: `ping`, `pullImage`, `createContainer`, `startContainer`, `stopContainer` (optional timeout in seconds), `removeContainer` (optional `force`), `inspectContainer`, `listContainers` (by labels), `containerLogs` (optional `tail`, `since`), `ensureNetwork`, `networkExists` and `ensureVolume`. Container operations SHALL accept an id or name. The interface SHALL reference no engine client library.

#### Scenario: Container is addressed by id or name
- **WHEN** a container named `web` is created and its id is returned
- **THEN** `inspectContainer` with the id and with `web` return the same container

#### Scenario: Interface is engine-neutral
- **WHEN** `src/runtime/types.ts` is read
- **THEN** it imports nothing outside `src/`

### Requirement: Images, networks and volumes

`pullImage` SHALL make an image available to `createContainer`. Creating a container from an image that was never pulled SHALL fail with `ImageNotFoundError`. `ensureNetwork` and `ensureVolume` SHALL create the named network or volume when it does not exist and SHALL succeed without change when it does. `networkExists` SHALL report whether a named network exists without creating it.

#### Scenario: Create needs a pulled image
- **WHEN** `createContainer` names an image that was never pulled
- **THEN** it fails with `ImageNotFoundError`

#### Scenario: Ensure is idempotent
- **WHEN** `ensureNetwork("paas-net")` is called twice
- **THEN** both calls succeed

#### Scenario: Network existence
- **WHEN** `networkExists("n1")` is called before and after `ensureNetwork("n1")`
- **THEN** it returns `false`, then `true`

### Requirement: Runtime contract suite

`runtimeContract(label, factory)` in `tests/support/runtime-contract.ts` SHALL register one `node:test` suite, `container runtime contract: <label>`, checking the interface requirements through `ContainerRuntime` only. It SHALL tolerate extra labels and filter only on labels unique to its run. The factory SHALL return a fresh harness per test: a runtime, a pullable image that runs until stopped, an image whose pull fails, and an optional teardown the suite always calls.

#### Scenario: Fake passes the contract
- **WHEN** `pnpm verify` runs
- **THEN** the suite `container runtime contract: fake` runs and passes

## ADDED Requirements

### Requirement: Container spec fields

A container spec SHALL carry a name, an image reference, environment variables, labels, a network, an internal port, a restart policy (`no`, `always`, `unless-stopped`, or `on-failure`), published ports each bound to a host address, and named volumes each mounted at a path. Only name and image are required.

#### Scenario: Minimal spec
- **WHEN** a container is created with only a name and a pulled image
- **THEN** creation succeeds

### Requirement: Engine details

`ping` SHALL return the engine's name and version, and MAY return its API version and the endpoint paas talks to. The fake SHALL return neither.

#### Scenario: Fake engine details
- **WHEN** the fake is pinged
- **THEN** it returns name `fake` and version `0.0.0` only

### Requirement: Docker adapter

`DockerRuntime` in `src/runtime/docker.ts` SHALL implement `ContainerRuntime` over the Docker Engine API through dockerode 4 on a Unix socket, for Docker Engine and for Podman's Docker-compatible API. It SHALL be the only module that imports dockerode. It SHALL not connect when constructed. It SHALL report engine name `podman` when the engine's version components name Podman, and `docker` otherwise, with the engine version, API version and socket path.

#### Scenario: Podman is recognised
- **WHEN** the engine's version response lists a component named `Podman Engine`
- **THEN** `ping` returns name `podman`

### Requirement: Socket resolution

The socket SHALL be resolved in this order: `PAAS_SOCKET`, a `unix://` value of `DOCKER_HOST`, `PODMAN_SOCKET`, then the first existing of `/var/run/docker.sock`, `~/.docker/run/docker.sock`, and `$XDG_RUNTIME_DIR/podman/podman.sock` (or `/run/user/<uid>/podman/podman.sock` when `XDG_RUNTIME_DIR` is unset). An explicit setting SHALL be final. A non-`unix://` `DOCKER_HOST` SHALL be ignored.

#### Scenario: Explicit socket is final
- **WHEN** `PAAS_SOCKET` names a path that does not exist and `/var/run/docker.sock` exists
- **THEN** resolution fails with `RuntimeUnavailableError` `cannot reach container engine at <path>: socket not found`

#### Scenario: Nothing found
- **WHEN** no variable is set and no default socket exists
- **THEN** resolution fails with `RuntimeUnavailableError` naming every path it tried and `PAAS_SOCKET`

### Requirement: Engine error mapping

The adapter SHALL map engine errors to the typed errors, keeping the engine's message and the original error as `cause`. A socket that refuses, is missing, or denies access SHALL become `RuntimeUnavailableError` `cannot reach container engine at <socket>: <code>`. A 404 SHALL become `ImageNotFoundError` on pull and create, and `ContainerNotFoundError` elsewhere. A 409 SHALL become `NameConflictError` only on create. A 304 on start or stop SHALL succeed.

#### Scenario: 409 on remove is not a name conflict
- **WHEN** the engine answers 409 to removing a running container without `force`
- **THEN** `removeContainer` fails with a `RuntimeError` that is not a `NameConflictError`

### Requirement: Pulling

`pullImage` SHALL resolve only after the whole pull stream finishes, and SHALL fail when the stream or any of its events reports an error. Every image reference paas pulls in tests SHALL be fully qualified, because Podman does not resolve short names by default.

#### Scenario: Error inside the stream
- **WHEN** the pull stream finishes with an event carrying an error
- **THEN** `pullImage` rejects

### Requirement: Log stream

For a container without a TTY, the adapter SHALL split the engine's multiplexed log stream into stdout and stderr entries by frame header, one entry per line, with the time the engine stamped on it. For a container with a TTY, every line SHALL be a stdout entry. `since` and `tail` SHALL be applied with millisecond precision.

#### Scenario: Multiplexed frames
- **WHEN** the log stream holds a stdout frame `a` and a stderr frame `b`
- **THEN** `containerLogs` returns a stdout entry `a` and a stderr entry `b`

### Requirement: Docker and Podman differences

Where the engines differ, the adapter SHALL behave the same through the interface. Known differences: Podman may answer a pull of a missing image with a 500 whose message says the manifest is unknown, does not exist, or access is denied, which SHALL map to `ImageNotFoundError`; Podman names itself in its version components; Podman requires fully qualified image references.

#### Scenario: Podman missing image
- **WHEN** a pull fails with status 500 and message `manifest unknown`
- **THEN** `pullImage` fails with `ImageNotFoundError`

### Requirement: Integration tier

`pnpm test:integration` SHALL run the contract suite against the engine the socket resolution finds, only when `PAAS_INTEGRATION=1`; otherwise it SHALL report the tests as skipped and exit 0. It SHALL use `registry.k8s.io/pause:3.10` as the present image, label every container, network and volume it creates `paas.test=true`, and remove them all after each test, even when a test fails. Integration files SHALL be named `*.itest.ts` so `pnpm verify` does not run them.

#### Scenario: Skipped without the variable
- **WHEN** `pnpm test:integration` runs without `PAAS_INTEGRATION=1`
- **THEN** it reports skipped tests and exits 0
