---
title: Ingress with Caddy
depends_on: ["006", "007", "008"]
verify: pnpm verify
features:
  reads: []
---
## Goal

Apps with a hostname are reachable through one Caddy container, `paas-caddy`, that paas manages. paas configures Caddy only through its admin API, never through the container socket, so routing is a pure function of paas state: one route per app that has a hostname and a running deployment.

`paas ingress up|down|status` manage the container. `paas deploy` pushes the new config after the new container is healthy and before the previous container is removed, so a pushed config never points at a removed container. `paas stop` pushes too.

## Verify

`pnpm verify`

It typechecks `src/` and `tests/` and runs every unit test offline: config generation, the settings migration, the Caddy container lifecycle on the fake runtime with a fake admin client, the loopback HTTP admin client against a local `node:http` server, the engine's `onRunning` hook, and the CLI commands in-process. After each task it must pass. The integration test that routes a real hostname through Caddy is in `pnpm test:integration` and is a human step.

## Non-goals

- Traefik, or any proxy that reads the container socket.
- Path-based routing, per-app TLS settings, or load balancing across replicas.
- Pushing config from `paas apps set` or `paas apps delete`. A changed hostname or port of a running app takes effect on its next deploy or stop, or on `paas ingress up`.
- Keeping Caddy's config across a Caddy restart the engine does on its own, such as after a host reboot. Caddy then serves its image's default page until the next push. `paas ingress up` pushes again, and the `reconcile` change will too.
- Keeping app containers on `paas-net` away from Caddy's admin API. It is closed to other hosts, but any container on `paas-net` can reach `paas-caddy:2019`. paas trusts the apps it runs.
- A configurable admin port on the CLI. Only the integration test uses another one.
- Changes to the `ContainerRuntime` interface or the fake runtime.

## Surface

- Added: `paas ingress` (command group)
- Added: `paas ingress up` (command) with `--tls <off|auto>`, `--http-port <n>`, `--https-port <n>` (flags)
- Added: `paas ingress down` (command)
- Added: `paas ingress status` (command) with `--json` (flag)
- Changed: `paas deploy` exits 1 with `paas: deployment <id> is running, but ingress update failed: <message>` when the push fails
- Changed: `paas stop` exits 1 with `paas: <app> is stopped, but ingress update failed: <message>` when the push fails
- Added: state database migration 2, table `settings`
- Added: container `paas-caddy`, volume `paas-caddy-data`, label `paas.ingress=caddy`, labels `paas.ingress.http-port` and `paas.ingress.https-port`

## Contract

The full contract is in the four deltas under `specs/`. The parts that matter most for review:

### Requirement: Admin API on loopback only

Container port 2019 SHALL be published only on host address `127.0.0.1`. Caddy SHALL listen on `0.0.0.0:2019` inside its container, set by `CADDY_ADMIN` and kept in every pushed config.

#### Scenario: Admin binding
- **WHEN** ingress is brought up
- **THEN** container port 2019 is published on `127.0.0.1:2019` and on no other host address

### Requirement: Running hook

`deploy` SHALL await its `onRunning` hook after marking the new deployment `running` and before replacing any previous deployment. When the hook rejects, `deploy` SHALL reject with its error and leave the new and every previous deployment running with their containers.

#### Scenario: Failed push keeps the previous container
- **WHEN** app `web` has running deployment A and deploy B's `onRunning` hook rejects
- **THEN** `deploy` rejects, B and A are both `running`, and both containers exist

### Requirement: Config generation

The config SHALL have one route per app with a hostname and a running deployment, dialing the newest running deployment's container name and the app's port over `paas-net`.

#### Scenario: Redeploy points at the new container
- **WHEN** app `web` (hostname `web.localhost`, port 8080) has running deployments A and then B
- **THEN** its only route dials `web-<B>:8080`

## Human steps

- Review the proposal, the four deltas and the seven task bodies. The approval digest should flag nothing: no task shares a file, no task changes a preexisting test, and no dependency changes.
- Run `osq approve 009-ingress-caddy` yourself.

After the change lands:

- Run `PAAS_INTEGRATION=1 pnpm test:integration` against Docker, and against rootless Podman with `PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock`. The new ingress test uses host ports 18080, 18443 and 12019, so it needs no sysctl and does not touch a real `paas-caddy`. Record the results in the "Known results" table of `docs/integration-testing.md`.
- If the ingress test gets HTTP 502 on Podman 3.4, containers on `paas-net` cannot resolve each other by name. Podman 3.4's CNI networks need the `dnsname` plugin (Ubuntu package `golang-github-containernetworking-plugin-dnsname`). Install it, remove `paas-net`, and run again. Record the outcome either way.
- For real use on rootless Podman, which cannot bind ports below 1024 by default: either run `sudo sysctl net.ipv4.ip_unprivileged_port_start=80`, or run `paas ingress up --http-port 8080 --https-port 8443`.
- `--tls auto` needs public DNS pointing at the host and host ports 80 and 443 reachable from the internet, or Caddy cannot obtain certificates.

## Delta

- `specs/ingress/spec.md`: new capability. Adds the Caddy container, loopback-only admin API, idempotent up, down, config generation, TLS modes, pushing config, waiting for the admin API, admin client errors, status, and code ownership of `src/ingress/**`.
- `specs/app-state/spec.md`: adds "Ingress settings" (migration 2, table `settings`).
- `specs/deployments/spec.md`: adds "Running hook" and modifies "Deploy result" so `deploy` may also reject with the hook's error. The hook is the only edit to the deployment engine: an optional `onRunning` field on `DeployOptions` in `src/deployments/engine.ts`, awaited between marking the new deployment `running` and `replacePrevious`, outside the `try` that fails a deployment. `src/deployments/stop.ts` does not change; `paas stop` pushes after `stopApp` returns.
- `specs/cli/spec.md`: adds the `ingress` command group, `ingress up`, `ingress down`, `ingress status`, and "Ingress follows deploys and stops"; modifies "Deploy command", "Deploy JSON" and "Stop command" for a failed push. The brief lists only `deployments` and `app-state`, but the new commands live in `src/commands/`, which `cli` owns.
- No file is shared between tasks. Task 1 owns `src/state/db.ts` and `src/state/settings.ts`; task 2 `src/ingress/config.ts`, `src/ingress/admin.ts` and `src/ingress/fake-admin.ts`; task 3 `src/ingress/caddy.ts`; task 4 `src/deployments/engine.ts`; task 5 `src/commands/ingress.ts`, `src/commands/context.ts` and `src/program.ts`; task 6 `src/commands/deploy.ts` and `src/commands/stop.ts`; task 7 `tests/integration/ingress.itest.ts` and `docs/integration-testing.md`.

### Where this departs from the brief

- The image is `docker.io/library/caddy:2`, not `caddy:2`. Podman does not resolve short names by default, as the `container-runtime` spec already records.
- Flags are `--tls`, `--http-port` and `--https-port`, following the `cli` spec's double-dash convention.
- "If a push fails, the deployment stays as it is" is read as: the new deployment stays `running`, and the previous one is not replaced, because Caddy still routes to it. Replacing it would leave traffic on a removed container. The next successful deploy replaces every older running deployment, as `replacePrevious` already does.
- A push is skipped when `paas-caddy` is missing or not running, so deploys work without ingress, and the existing deploy tests stay unchanged.
