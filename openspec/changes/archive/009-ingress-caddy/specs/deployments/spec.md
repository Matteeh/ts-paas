# Spec Delta

## ADDED Requirements

### Requirement: Running hook

`deploy` SHALL accept an optional `onRunning` hook. It SHALL await the hook once, with the new deployment, after marking it `running` and before replacing any previous deployment. When the hook rejects, `deploy` SHALL reject with the hook's error, the new deployment SHALL stay `running` with its container, and every previous deployment and its container SHALL stay as they were.

#### Scenario: Hook runs before replacement
- **WHEN** app `web` has running deployment A and deploy B's `onRunning` hook is called
- **THEN** at that moment B is `running`, A is `running`, and A's container is running

#### Scenario: Failed hook keeps both deployments
- **WHEN** app `web` has running deployment A and deploy B's `onRunning` hook rejects with `push failed`
- **THEN** `deploy` rejects with that error, B and A are both `running`, and both containers are running

#### Scenario: Hook is not called for a failed deploy
- **WHEN** the new container fails its health window
- **THEN** the `onRunning` hook is never called

## MODIFIED Requirements

### Requirement: Deploy result

`deploy` SHALL resolve with the final deployment record, `running` or `failed`. It SHALL reject only when the app does not exist (`AppNotFoundError`), a deploy is already in progress, or its `onRunning` hook rejects.

#### Scenario: Failure resolves
- **WHEN** a deploy fails its health window
- **THEN** `deploy` resolves with a deployment whose status is `failed`
