---
title: Docker and Podman adapter
depends_on: ["002", "006"]
verify: pnpm verify
features:
  reads:
    - deployments
---
## Goal

A dockerode-based `DockerRuntime` implements `ContainerRuntime` for Docker Engine and rootless Podman on a local Unix socket. It passes the same contract suite as the fake: offline against a stubbed client in `pnpm verify`, and against a real engine in `pnpm test:integration`. The CLI's default runtime factory becomes this adapter, and `paas doctor` reports which engine paas talks to.

This change also depends on 006, because it replaces the default runtime factory in `src/commands/context.ts` and updates two tests 006 wrote.

## Verify

`pnpm verify`

It typechecks and runs every unit test offline: the interface additions on the fake, socket resolution and log demultiplexing as pure functions, the adapter against a stubbed dockerode client, and the CLI with an injected fake or a missing socket. No unit test talks to a real engine. The integration files (`*.itest.ts`) typecheck but do not run. After each task it must pass.

## Non-goals

- Remote engines over TCP or SSH, and TLS to the engine.
- The build API.
- Podman's `CONTAINER_HOST` and the rootful Podman socket; `PAAS_SOCKET` covers them for now.
- Running the integration tier in `pnpm verify`.

## Surface

- Added: `paas doctor` (command) with `--json`
- Added: `PAAS_SOCKET`, `PODMAN_SOCKET` (environment variables; explicit engine socket)
- Changed: `DOCKER_HOST` (a `unix://` value now selects the engine socket)
- Added: `PAAS_INTEGRATION` (environment variable; `1` runs the integration tier)
- Added: `pnpm test:integration` (package script)
- Added: `paas.test=true` (label on everything integration tests create)
- Added: `cannot reach container engine at <socket>: <reason>` and `no container engine socket found; ...` (error messages)
- Removed: `no container runtime is configured yet` (error message)
- Changed: `ContainerRuntime` gains `networkExists`; `EngineInfo` gains optional `apiVersion` and `endpoint`

## Contract

The full contract is in the `container-runtime` and `cli` deltas. In short:

### Requirement: Socket resolution

Explicit settings (`PAAS_SOCKET`, a `unix://` `DOCKER_HOST`, `PODMAN_SOCKET`) SHALL be final; only the default socket paths are probed.

#### Scenario: Explicit socket is final
- **WHEN** `PAAS_SOCKET` names a path that does not exist and `/var/run/docker.sock` exists
- **THEN** resolution fails with `RuntimeUnavailableError` `cannot reach container engine at <path>: socket not found`

### Requirement: Engine error mapping

A 409 SHALL be a name conflict only on create; 404s SHALL map by operation; a 304 on start or stop SHALL succeed.

#### Scenario: 409 on remove is not a name conflict
- **WHEN** the engine answers 409 to removing a running container without `force`
- **THEN** `removeContainer` fails with a `RuntimeError` that is not a `NameConflictError`

### Requirement: Default container runtime

Commands SHALL ping the runtime before opening the state database, so an unreachable engine leaves state untouched.

#### Scenario: Unreachable engine
- **WHEN** app `web` exists, `PAAS_SOCKET` names a missing path, and a user runs `paas deploy web`
- **THEN** stderr is exactly `paas: cannot reach container engine at <path>: socket not found` and a newline, the exit code is 1, and no deployment is created

## Human steps

Before approving (tasks run offline and must not touch dependencies):

- Run `pnpm add dockerode@4.0.12` and `pnpm add -D @types/dockerode@4.0.1`. dockerode 5 ships no types and `@types/dockerode` is still 4.x, so stay on the 4.x major.
- pnpm will stop with `ERR_PNPM_IGNORED_BUILDS` and write placeholders under `allowBuilds` in `pnpm-workspace.yaml` (expect ssh2, cpu-features and protobufjs). Set each to `false`: paas never uses SSH and needs no native builds. Then run `pnpm install` and check that it succeeds.
- Commit `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`.
- Review the proposal, both deltas, and the four task bodies. Expect the approval digest to flag `sensitive_path` for `package.json` in task 3 (it adds the `test:integration` script) and `tests.modify` in tasks 1 and 4.
- Run `osq approve 007-docker-podman-adapter` yourself.

After the change lands:

- Run `PAAS_INTEGRATION=1 pnpm test:integration` against Docker.
- On Linux, run `systemctl --user enable --now podman.socket`, stop Docker or set `PAAS_SOCKET` to the Podman socket, and run it again.
- Record any contract difference between the two engines. Each one becomes a line in the `Docker and Podman differences` requirement through a follow-up change.

## Delta

- `specs/container-runtime/spec.md`: modifies the interface (adds `networkExists`), images/networks/volumes, and the contract suite (tolerates extra labels, run-unique filter labels). Adds container spec fields, engine details, the Docker adapter, socket resolution, error mapping, pulling, the log stream, Docker/Podman differences, and the integration tier.
- `specs/cli/spec.md`: removes the placeholder `Runtime factory` requirement and adds `Default container runtime` (Docker adapter by default, ping before the store) and `paas doctor`.
- No file is shared between tasks. Task 1 owns `src/runtime/types.ts`, `src/runtime/fake.ts`, the contract suite and the clock test. Task 2 owns `src/runtime/socket.ts` and `src/runtime/docker-logs.ts`. Task 3 owns `src/runtime/docker.ts`, the integration test and `package.json`. Task 4 owns `src/commands/context.ts`, `src/commands/doctor.ts` and `src/program.ts`.
