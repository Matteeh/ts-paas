# Spec Delta

## Purpose

The `deployments` capability takes an app from its stored spec to a running container through the container runtime, records every status change in the state store, and never takes down an app's working container when a new deployment fails.

## ADDED Requirements

### Requirement: Deployment flow

`deploy` SHALL create a deployment for the app's current image and move it through `pending`, `pulling`, `starting` and `running`, recording each step in the store. It SHALL pull the image on every deploy. The container id SHALL be recorded when the deployment enters `starting`, after the container is created and before it starts.

#### Scenario: Happy path
- **WHEN** app `web` with image `nginx:1` and no deployments is deployed on the fake runtime and the clock passes the health window
- **THEN** the deployment's status changes are `pending`, `pulling`, `starting`, `running` in that order, its container id is set, and its container is running

### Requirement: Container spec

The new container SHALL be named `<app>-<deployment id>`, carry the labels `paas.app=<app>` and `paas.deployment=<deployment id>` (the runtime adds `paas.managed=true`), join the network `paas-net`, which the engine ensures first, expose the app's port as its internal port, get the app's environment, and use the restart policy `unless-stopped`.

#### Scenario: Labels and name
- **WHEN** app `web` is deployed and the deployment id is `abc123`
- **THEN** the container `web-abc123` has labels `paas.app=web`, `paas.deployment=abc123` and `paas.managed=true`, and the network `paas-net` exists

### Requirement: Health window

A started container SHALL be healthy when, at the end of a window on the injected clock, three seconds by default, it is still `running`, its restart count is 0, and its start time is unchanged. A container that is not running right after start SHALL fail at once, without waiting for the window. The engine SHALL never wait on real time.

#### Scenario: Exits inside the window
- **WHEN** the new container exits with code 3 one second after start and the window is three seconds
- **THEN** the deployment fails once the clock reaches the end of the window

#### Scenario: Exits exactly at the window's end
- **WHEN** the new container exits exactly three seconds after start and the window is three seconds
- **THEN** the deployment fails

#### Scenario: Restarted by the engine
- **WHEN** the container is `running` at the end of the window but its restart count is 1
- **THEN** the deployment fails with `container restarted during the health window`

### Requirement: Health failure

When a new container fails its health window, the engine SHALL read its last 20 log lines, then force-remove it, then mark the deployment `failed` with an error of `container exited with code <n>` (or `container restarted during the health window`) followed by one line per log line. A previous running deployment SHALL keep running.

#### Scenario: Failure keeps the previous deployment
- **WHEN** app `web` has a running deployment and a new deploy's container exits with code 3 after writing 25 log lines
- **THEN** the new deployment is `failed`, its error starts with `container exited with code 3` and contains exactly the last 20 lines, its container is gone, and the previous deployment and its container are still running

### Requirement: Replacement after health

Only after the new deployment is marked `running` SHALL the engine stop and remove the previous running deployment's container and mark that deployment `replaced`. A previous container that no longer exists SHALL count as removed.

#### Scenario: Redeploy replaces
- **WHEN** app `web` has running deployment A and a new deploy B becomes healthy
- **THEN** B is `running`, A is `replaced` with a finish time, A's container is gone, and B was marked `running` before A was marked `replaced`

### Requirement: Failed removal of the previous container

When stopping or removing the previous container fails after the new deployment is `running`, the engine SHALL still mark the previous deployment `replaced`, leave its container for reconcile to report as an orphan, and report the failure in the `replaced` progress message. The new deployment SHALL stay `running`.

#### Scenario: Previous container cannot be removed
- **WHEN** removing deployment A's container fails with a runtime error while B replaces it
- **THEN** B is `running`, A is `replaced`, `deploy` resolves, and the `replaced` progress message contains the runtime error's message

### Requirement: Pull failure

When the pull fails, the deployment SHALL fail with the runtime's message and no container SHALL be created.

#### Scenario: Missing image
- **WHEN** app `web`'s image fails to pull with `ImageNotFoundError`
- **THEN** the deployment is `failed` with the runtime's message, and no container labelled `paas.app=web` exists for it

### Requirement: Runtime errors

When the runtime fails at any step, the deployment SHALL fail with the runtime's message, the engine SHALL force-remove the new container if it was created, ignoring errors from that removal, and nothing that was running before SHALL stop.

#### Scenario: Name conflict on create
- **WHEN** a container named like the new deployment's container already exists
- **THEN** the deployment is `failed` with the `NameConflictError` message and the previous deployment is still running

#### Scenario: Start fails
- **WHEN** `startContainer` fails with a `RuntimeError`
- **THEN** the deployment is `failed` with its message and the new container has been removed

### Requirement: One deploy at a time

`deploy` SHALL refuse with `DeploymentInProgressError` when the app has a deployment in `pending`, `pulling` or `starting`. The check and the creation of the new deployment SHALL happen without an asynchronous step between them.

#### Scenario: Concurrent deploy
- **WHEN** a deploy of `web` is waiting in its health window and a second deploy of `web` starts
- **THEN** the second call rejects with `DeploymentInProgressError` and creates no deployment

### Requirement: Deploy result

`deploy` SHALL resolve with the final deployment record, `running` or `failed`. It SHALL reject only when the app does not exist (`AppNotFoundError`) or a deploy is already in progress.

#### Scenario: Failure resolves
- **WHEN** a deploy fails its health window
- **THEN** `deploy` resolves with a deployment whose status is `failed`

### Requirement: Progress reporting

The engine SHALL call the progress callback it is given once for every status change it records, for the new deployment and for a replaced one, with the deployment id, the new status, and a one-line message. The callback and the clock SHALL be parameters, never globals.

#### Scenario: Progress for a redeploy
- **WHEN** a redeploy of `web` succeeds
- **THEN** the callback receives `pending`, `pulling`, `starting`, `running` for the new deployment and then `replaced` for the previous one, each with a non-empty message

### Requirement: Stopping an app

`stopApp` SHALL stop and remove the app's running deployment's container and mark that deployment `stopped`, reporting it through the progress callback. A container that no longer exists SHALL count as removed. An app without a running deployment SHALL fail with `AppNotRunningError`. If the runtime fails, the deployment SHALL stay `running`.

#### Scenario: Stop
- **WHEN** app `web` has a running deployment and is stopped
- **THEN** its container is gone and the deployment is `stopped` with a finish time

#### Scenario: Nothing to stop
- **WHEN** app `web` has no running deployment and is stopped
- **THEN** it fails with `AppNotRunningError`

### Requirement: Code ownership
<!-- source: src/deployments/** -->
The deployments capability SHALL own the deployment flow, the health check, stopping apps, and their errors and types.

#### Scenario: Codebase ownership boundaries
- **WHEN** file ownership is resolved for deployments
- **THEN** system maps `src/deployments/**` to deployments
