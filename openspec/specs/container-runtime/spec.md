# container-runtime Specification

## Purpose
The `container-runtime` capability is the one interface through which paas talks to a container engine, the injected clock that makes timing testable, the deterministic in-memory fake engine, and the contract every runtime implementation must pass.

## Requirements

### Requirement: Runtime interface

paas SHALL reach a container engine only through the `ContainerRuntime` interface in `src/runtime/types.ts`. The interface SHALL offer: `ping` (engine name and version), `pullImage` (by reference), `createContainer` (from a spec, returning the container id), `startContainer`, `stopContainer` (with an optional timeout in seconds), `removeContainer` (with an optional `force`), `inspectContainer`, `listContainers` (by labels), `containerLogs` (with optional `tail` and `since`), `ensureNetwork`, and `ensureVolume`. Every operation that takes a container SHALL accept its id or its name. The interface and its types SHALL not reference any engine client library.

A container spec SHALL carry a name, an image reference, environment variables, labels, a network, an internal port, a restart policy (`no`, `always`, `unless-stopped`, or `on-failure`), published ports each bound to a host address, and named volumes each mounted at a path. Only name and image are required.

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

`pullImage` SHALL make an image available to `createContainer`. Creating a container from an image that was never pulled SHALL fail with `ImageNotFoundError`. `ensureNetwork` and `ensureVolume` SHALL create the named network or volume when it does not exist and SHALL succeed without change when it does.

#### Scenario: Create needs a pulled image
- **WHEN** `createContainer` names an image that was never pulled
- **THEN** it fails with `ImageNotFoundError`

#### Scenario: Ensure is idempotent
- **WHEN** `ensureNetwork("paas-net")` is called twice
- **THEN** both calls succeed

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

`runtimeContract(label, factory)` in `tests/support/runtime-contract.ts` SHALL register one `node:test` suite named `container runtime contract: <label>` that checks every requirement above except the fake's scripting, through the `ContainerRuntime` interface only. The factory SHALL return a fresh harness per test: a runtime, an image reference that can be pulled and runs until stopped, an image reference whose pull fails, and an optional teardown that the suite SHALL call even when a test fails. `pnpm verify` SHALL run the suite against `FakeRuntime`. Every later runtime implementation SHALL pass it.

#### Scenario: Fake passes the contract
- **WHEN** `pnpm verify` runs
- **THEN** the suite `container runtime contract: fake` runs and passes

### Requirement: Code ownership
<!-- source: src/clock.ts, src/runtime/** -->
The container-runtime capability SHALL own the injected clock, the runtime interface and its types, the typed runtime errors, and every runtime implementation, including the fake.

#### Scenario: Codebase ownership boundaries
- **WHEN** file ownership is resolved for container-runtime
- **THEN** system maps `src/clock.ts` and `src/runtime/**` to container-runtime
