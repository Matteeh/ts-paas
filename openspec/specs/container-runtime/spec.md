# container-runtime Specification

## Purpose
The `container-runtime` capability is the one interface through which paas talks to a container engine, the injected clock that makes timing testable, the deterministic in-memory fake engine, and the contract every runtime implementation must pass.

## Requirements

### Requirement: Runtime interface

paas SHALL reach an engine only through `ContainerRuntime` in `src/runtime/types.ts`: `ping`, `pullImage`, `createContainer`, `startContainer`, `stopContainer` (optional timeout in seconds), `removeContainer` (optional `force`), `inspectContainer`, `listContainers` (by labels), `containerLogs` (optional `tail`, `since`), `ensureNetwork`, `networkExists` and `ensureVolume`. Container operations SHALL accept an id or name. The interface SHALL reference no engine client library.

#### Scenario: Container is addressed by id or name
- **WHEN** a container named `web` is created and its id is returned
- **THEN** `inspectContainer` with the id and with `web` return the same container

#### Scenario: Interface is engine-neutral
- **WHEN** `src/runtime/types.ts` is read
- **THEN** it imports nothing outside `src/`

### Requirement: Managed label

Every container created through a `ContainerRuntime` SHALL carry the label `paas.managed=true`, in addition to the labels in its spec. The runtime SHALL add it; callers SHALL not need to. The label key SHALL be exported as `MANAGED_LABEL`.

#### Scenario: Runtime adds the managed label
- **WHEN** a container is created with labels `{ "paas.app": "web" }`
- **THEN** its inspected labels include `paas.app=web` and `paas.managed=true`

### Requirement: Container lifecycle

A created container SHALL be in state `created`. `startContainer` SHALL move it to `running` and set when it started; starting a running container SHALL change nothing. `stopContainer` SHALL move a running container to `exited` with a numeric exit code; stopping a container that is not running SHALL succeed and change nothing. `removeContainer` SHALL delete a container that is not running; removing a running container SHALL fail with a `RuntimeError` and leave it running unless `force` is set, in which case it SHALL be removed.

#### Scenario: Start then stop
- **WHEN** a created container is started and then stopped
- **THEN** inspection shows `running` with a start time after the start, and `exited` with a numeric exit code after the stop

#### Scenario: Stop is idempotent
- **WHEN** an exited container is stopped again
- **THEN** the call succeeds and the container stays `exited`

#### Scenario: Running container needs force to remove
- **WHEN** `removeContainer` is called on a running container without `force`
- **THEN** it fails with a `RuntimeError` and the container is still running; with `force` it is removed and inspecting it fails with `ContainerNotFoundError`

### Requirement: Inspection

`inspectContainer` SHALL return the container's id, name, image, labels, state (`created`, `running`, or `exited`), exit code (`null` unless `exited`), when it started (`null` if never started), when it finished (`null` unless `exited`), and its restart count. `listContainers` SHALL return a summary (id, name, image, labels, state) of every container that carries all of the given labels, in any state, including `exited`.

#### Scenario: Fresh container inspection
- **WHEN** a container is created and not started
- **THEN** its state is `created`, exit code, start time and finish time are `null`, and restart count is 0

#### Scenario: List filters by every label
- **WHEN** containers A with `{x: "1", y: "1"}`, B with `{x: "1"}`, and C with `{x: "1", y: "1"}` exist and C has exited
- **THEN** `listContainers({x: "1", y: "1"})` returns A and C, not B

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

### Requirement: Logs

`containerLogs` SHALL return a container's log entries oldest first, each with its stream (`stdout` or `stderr`), time, and text. With `since`, only entries at or after that time SHALL be returned. With `tail` n, only the last n of the remaining entries SHALL be returned.

#### Scenario: Tail and since
- **WHEN** a container logged lines at times t1 < t2 < t3 and logs are read with `since` t2 and `tail` 1
- **THEN** only the t3 entry is returned

### Requirement: Typed runtime errors

Runtime failures SHALL be instances of `RuntimeError`. Four subclasses SHALL name the expected failures: `ImageNotFoundError`, `ContainerNotFoundError` (any operation on an unknown id or name), `NameConflictError` (creating a container whose name exists, in any state), and `RuntimeUnavailableError` (the engine cannot be reached). Each error SHALL keep the underlying message as its message and the underlying error as its `cause`, and SHALL have `name` equal to its class name.

#### Scenario: Name conflict
- **WHEN** a container named `web` exists, even exited, and another is created with name `web`
- **THEN** `createContainer` fails with `NameConflictError`

#### Scenario: Unknown container
- **WHEN** `startContainer`, `stopContainer`, `removeContainer`, `inspectContainer`, or `containerLogs` names a container that does not exist
- **THEN** it fails with `ContainerNotFoundError`

### Requirement: Injected clock

Code that reads the time or waits SHALL do so through the `Clock` interface in `src/clock.ts`: `now()` and `sleep(ms)`. `systemClock` SHALL use real time. `FakeClock` SHALL stand still until `advance(ms)` is called; `advance` SHALL resolve every sleep that falls due, in due order, with `now()` equal to each sleep's due time as it resolves, and SHALL settle only after work chained on those sleeps has run.

#### Scenario: Fake clock only moves on advance
- **WHEN** code sleeps 3000 ms on a `FakeClock` and the test advances 2999 ms, then 1 ms more
- **THEN** the sleep is still pending after the first advance and resolved after the second, with `now()` 3000 ms after the start

### Requirement: Fake runtime

`FakeRuntime` in `src/runtime/fake.ts` SHALL implement `ContainerRuntime` in memory, deterministically, and without timers other than its injected clock. It SHALL report engine name `fake`. It SHALL assign container ids in creation order. It SHALL record the restart policy but never restart a container, so its restart count stays 0. Tests SHALL be able to script it:
- a list of image references whose pull fails with `ImageNotFoundError`;
- per image, an exit code and an optional delay: without a delay, a started container is `exited` with that code when `startContainer` returns; with a delay, it exits with that code once the injected clock has advanced by the delay while it runs;
- per image, log lines a container writes when it starts, timestamped with the clock's time;
- an `unavailable` switch that makes every operation fail with `RuntimeUnavailableError`.

A container whose image has no script SHALL run until stopped. Stopping it SHALL record exit code 0.

#### Scenario: Container exits immediately
- **WHEN** image `crash:1` is scripted to exit with code 3 and a container from it is started
- **THEN** inspection right after `startContainer` shows `exited` with exit code 3

#### Scenario: Container exits after a delay
- **WHEN** image `slow:1` is scripted to exit with code 1 after 2000 ms, a container from it is started, and the fake clock advances 2000 ms
- **THEN** it is `running` before the advance and `exited` with code 1 and finish time at the clock's time after it

#### Scenario: Engine unavailable
- **WHEN** the fake's `unavailable` switch is on
- **THEN** `ping` and every other operation fail with `RuntimeUnavailableError`

### Requirement: Runtime contract suite

`runtimeContract(label, factory)` in `tests/support/runtime-contract.ts` SHALL register one `node:test` suite, `container runtime contract: <label>`, checking the interface requirements through `ContainerRuntime` only. It SHALL tolerate extra labels and filter only on labels unique to its run. The factory SHALL return a fresh harness per test: a runtime, a pullable image that runs until stopped, an image whose pull fails, and an optional teardown the suite always calls.

#### Scenario: Fake passes the contract
- **WHEN** `pnpm verify` runs
- **THEN** the suite `container runtime contract: fake` runs and passes

### Requirement: Code ownership
<!-- source: src/clock.ts, src/runtime/** -->
The container-runtime capability SHALL own the injected clock, the runtime interface and its types, the typed runtime errors, and every runtime implementation, including the fake.

#### Scenario: Codebase ownership boundaries
- **WHEN** file ownership is resolved for container-runtime
- **THEN** system maps `src/clock.ts` and `src/runtime/**` to container-runtime

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

The adapter SHALL map engine errors to typed errors, keeping the engine's message and the original error as `cause`. A socket that refuses, is missing, or denies access SHALL become `RuntimeUnavailableError` `cannot reach container engine at <socket>: <code>`. A 404 SHALL become `ImageNotFoundError` on pull and create, and `ContainerNotFoundError` elsewhere. On create only, a 409, or a 500 saying the name is already in use, SHALL become `NameConflictError`. A 304 on start or stop SHALL succeed.

#### Scenario: 409 on remove is not a name conflict
- **WHEN** the engine answers 409 to removing a running container without `force`
- **THEN** `removeContainer` fails with a `RuntimeError` that is not a `NameConflictError`

#### Scenario: Other 500 on create
- **WHEN** create fails with status 500 and a message that does not say the name is in use
- **THEN** `createContainer` fails with a `RuntimeError` that is not a `NameConflictError`

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

`pnpm test:integration` SHALL run each `*.itest.ts` file only when `PAAS_INTEGRATION=1`, and otherwise report skipped tests and exit 0. The contract suite SHALL run against the engine socket resolution finds, be labelled `<engine name> (<socket>)`, and use `registry.k8s.io/pause:3.10`. Each file SHALL label what it creates with its own `paas.test` value (`true` for the contract suite) and remove only that, even on failure, because files run in parallel.

#### Scenario: Skipped without the variable
- **WHEN** `pnpm test:integration` runs without `PAAS_INTEGRATION=1`
- **THEN** it reports skipped tests and exits 0

#### Scenario: Suite names the engine
- **WHEN** the integration tier runs against rootless Podman on `/run/user/1000/podman/podman.sock`
- **THEN** the suite is named `container runtime contract: podman (/run/user/1000/podman/podman.sock)`

#### Scenario: Files run in parallel
- **WHEN** the contract suite and the ingress test run at the same time
- **THEN** the contract suite's cleanup removes only `paas.test=true` resources and the ingress test's removes only `paas.test=ingress` ones

### Requirement: List state matches inspection

The state `listContainers` reports for each container SHALL be the state `inspectContainer` would report at that moment. The Docker adapter SHALL take each listed container's state from inspecting it, and SHALL leave out a container that disappears between listing and inspecting.

#### Scenario: Stopped container in a lagging list
- **WHEN** the engine's list still reports a just-stopped container as `running` but inspecting it reports `exited`
- **THEN** `listContainers` reports it as `exited`

#### Scenario: Container removed while listing
- **WHEN** a listed container's inspect answers 404
- **THEN** `listContainers` leaves it out and does not fail
