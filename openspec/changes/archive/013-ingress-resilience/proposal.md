---
title: Ingress that survives a stopped Caddy and a busy port
depends_on: ["012"]
verify: pnpm verify
features:
  reads: []
---
## Goal

paas notices when Caddy is not running and brings it back, and a host port that is already in use produces an error that says what to do. Both came up in the first end-to-end runs on rootless Podman 3.4.4:
- Podman does not apply the `unless-stopped` restart policy, so a crashed Caddy stays down and every route with it. paas said nothing.
- Podman leaks `containers-rootlessport` port forwarders for containers that the `podman` command started. Those forwarders keep host ports busy, and paas then passed the raw engine message through.

paas cannot fix Podman. This change makes paas resilient to it and records the behavior in the spec and the docs.

## Verify

`pnpm verify`

It typechecks `src/` and `tests/` and runs every unit test offline: the adapter's busy-port mapping against the stubbed dockerode client, `ingressUp`'s cleanup on the fake runtime, reconcile starting a stopped Caddy and the busy-port message in-process with a fake admin client, and the docs checks. After each task it must pass. The checks on a real rootless Podman are human steps.

## Non-goals

- Killing leaked `containers-rootlessport` processes. paas does not manage host processes.
- A background watchdog. Reconcile stays something the user runs.
- Restarting stopped app containers. Reconcile already fails their deployments, and `--redeploy` brings them back.
- Starting a missing `paas-caddy`. A missing container means ingress was brought down on purpose.

## Surface

- Added: `PortInUseError` (typed runtime error)
- Added: reconcile item kind `start-ingress`, printed as `start-ingress: paas-caddy (started, <n> routes)`
- Changed: any command that fails because a host port is busy prints `paas: host port <address> is already in use; find what holds it with "ss -ltnp | grep :<port>" (on rootless Podman a leftover containers-rootlessport process can hold it; see docs/manual-testing.md)`
- Changed: `paas ingress up` and `paas up` remove the `paas-caddy` they created when it cannot start
- Added: `docs/manual-testing.md` section "Podman 3.4 port forwarders"

## Contract

The full contract is in the three deltas under `specs/`. In short:

### Requirement: Reconcile starts a stopped Caddy

`paas reconcile` SHALL bring up a `paas-caddy` that exists but is not running, which pushes the config, and report it as `start-ingress`.

#### Scenario: Caddy crashed
- **WHEN** ingress was up, `web` with hostname `web.localhost` runs, and `paas-caddy` has exited
- **THEN** `paas reconcile` prints `start-ingress: paas-caddy (started, 1 routes)`, `paas-caddy` runs, and its config routes `web.localhost`

### Requirement: Busy host ports

A container start that fails because a host port is taken SHALL fail with `PortInUseError`, and the CLI SHALL name the port and how to find what holds it.

#### Scenario: Leaked forwarder holds the admin port
- **WHEN** starting `paas-caddy` fails with `rootlessport listen tcp 127.0.0.1:2019: bind: address already in use`
- **THEN** `paas up` exits 1, stderr starts `paas: host port 127.0.0.1:2019 is already in use`, and no `paas-caddy` container exists

## Human steps

- Review the proposal, the three deltas and the four task bodies. The approval digest should flag nothing: no task shares a file or changes a preexisting test, and no dependency changes.
- Run `osq approve 013-ingress-resilience` yourself.

After the change lands, on rootless Podman (`export PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock`):

- Run `paas up --http-port 28080 --https-port 28443`, deploy an app with a hostname, and run `podman kill --signal KILL paas-caddy`. `paas status` should warn, and `paas reconcile` should print `start-ingress` and restore the route.
- Hold a port with `python3 -m http.server 28081`, then run `paas ingress down` and `paas up --http-port 28081 --https-port 28443`. It should print the busy-port message, and `podman ps -a` should show no `paas-caddy`.
- Clean up, check that no `containers-rootlessport` process is left (`ps -eo pid,cmd | grep rootlessport`), and record the results, with change 012's e2e runs, in the "Known results" table of `docs/integration-testing.md`.

## Delta

- `specs/container-runtime/spec.md`: modifies "Typed runtime errors" (adds `PortInUseError`); adds "Busy host ports" and "Rootless Podman 3.4 limits". "Docker and Podman differences" is already close to the length limit, so the Podman 3.4 behavior gets its own requirement.
- `specs/ingress/spec.md`: adds "Failed start leaves no container".
- `specs/cli/spec.md`: adds "Reconcile starts a stopped Caddy" and "Busy host port message".
- No file is shared between tasks. Task 1 owns `src/runtime/errors.ts` and `src/runtime/docker.ts`; task 2 owns `src/ingress/caddy.ts`; task 3 owns `src/commands/context.ts` and `src/commands/reconcile.ts`; task 4 owns `docs/manual-testing.md` and `README.md`. Each task also owns one new test file.
- Reconcile starts Caddy through the existing `ingressUp`, which already starts a stopped `paas-caddy` and pushes with retries while the admin API comes up. A bare start followed by one push would race Caddy's startup. So `src/ingress/caddy.ts` needs no new function for it.
