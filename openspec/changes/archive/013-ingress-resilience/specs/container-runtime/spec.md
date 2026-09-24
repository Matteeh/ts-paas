# Spec Delta

## MODIFIED Requirements

### Requirement: Typed runtime errors

Runtime failures SHALL be instances of `RuntimeError`. Five subclasses SHALL name the expected failures: `ImageNotFoundError`, `ContainerNotFoundError` (an unknown id or name), `NameConflictError` (a container name that exists, in any state), `RuntimeUnavailableError` (the engine cannot be reached), and `PortInUseError` (a host port to publish is taken). Each SHALL keep the underlying message and error as its `message` and `cause`, and SHALL have `name` equal to its class name.

#### Scenario: Name conflict
- **WHEN** a container named `web` exists, even exited, and another is created with name `web`
- **THEN** `createContainer` fails with `NameConflictError`

#### Scenario: Unknown container
- **WHEN** `startContainer`, `stopContainer`, `removeContainer`, `inspectContainer`, or `containerLogs` names a container that does not exist
- **THEN** it fails with `ContainerNotFoundError`

## ADDED Requirements

### Requirement: Busy host ports

When creating or starting a container fails with a message that says `address already in use`, `port is already allocated` or `Ports are not available`, the adapter SHALL fail with `PortInUseError`. Its `address` SHALL be the host address and port the message names, such as `127.0.0.1:2019`, or `null` when it names none. This rule SHALL take precedence over the name-conflict rule.

#### Scenario: Podman rootlessport
- **WHEN** start fails with status 500 and `rootlessport listen tcp 0.0.0.0:28080: bind: address already in use`
- **THEN** `startContainer` fails with `PortInUseError` whose `address` is `0.0.0.0:28080`

#### Scenario: Docker Engine
- **WHEN** start fails with `driver failed programming external connectivity on endpoint paas-caddy (...): Bind for 0.0.0.0:8080 failed: port is already allocated`
- **THEN** `startContainer` fails with `PortInUseError` whose `address` is `0.0.0.0:8080`

#### Scenario: Docker Desktop
- **WHEN** start fails with `Ports are not available: exposing port TCP 127.0.0.1:2019 -> 0.0.0.0:0: listen tcp 127.0.0.1:2019: bind: Only one usage of each socket address`
- **THEN** `startContainer` fails with `PortInUseError` whose `address` is `127.0.0.1:2019`

#### Scenario: Name conflict is unchanged
- **WHEN** create fails with status 500 and a message ending `that name is already in use`
- **THEN** `createContainer` still fails with `NameConflictError`

### Requirement: Rootless Podman 3.4 limits

On rootless Podman 3.4, restart policies are not applied: a container that exits stays exited. A container the `podman` command started or restarted can leave its `containers-rootlessport` process listening on the published host ports after it stops or is removed. paas SHALL never rely on the engine restarting a container, and SHALL never start containers through the `podman` command.

#### Scenario: Crashed container stays down
- **WHEN** a container with restart policy `unless-stopped` is killed on rootless Podman 3.4
- **THEN** it stays `exited`, and bringing it back is up to paas
