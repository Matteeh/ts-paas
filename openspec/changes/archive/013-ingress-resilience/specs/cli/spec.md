# Spec Delta

## ADDED Requirements

### Requirement: Reconcile starts a stopped Caddy

When `paas-caddy` exists but is not running, `paas reconcile` SHALL bring it up with `ingressUp`, which starts it and pushes the config, and SHALL report one item of kind `start-ingress`: `start-ingress: paas-caddy (started, <n> routes)`, or `failed: <message>` as its detail. It SHALL then add no `push-ingress` item. A dry run SHALL plan it, and `paas status` SHALL count it in its drift warning.

#### Scenario: Caddy crashed
- **WHEN** ingress was up, `web` with hostname `web.localhost` runs, and `paas-caddy` has exited
- **THEN** `paas reconcile` prints `start-ingress: paas-caddy (started, 1 routes)`, `paas-caddy` runs, and its config routes `web.localhost`

#### Scenario: Dry run
- **WHEN** `paas-caddy` has exited and a user runs `paas reconcile --dry-run`
- **THEN** stdout has `start-ingress: paas-caddy (planned)` and `paas-caddy` stays exited

#### Scenario: Status warns
- **WHEN** `paas-caddy` has exited and everything else agrees
- **THEN** `paas status` prints `paas: warning: state and engine disagree on 1 item(s); run paas reconcile --dry-run` to stderr

#### Scenario: Ingress brought down on purpose
- **WHEN** no `paas-caddy` exists
- **THEN** `paas reconcile` adds no `start-ingress` item

### Requirement: Busy host port message

When a command fails with `PortInUseError`, stderr SHALL be the one line `paas: host port <address> is already in use; find what holds it with "ss -ltnp | grep :<port>" (on rootless Podman a leftover containers-rootlessport process can hold it; see docs/manual-testing.md)`, and the exit code SHALL be 1. With no address, it SHALL say `a host port is already in use (<first line of the engine message>)` and drop the `grep`. A failed `start-ingress` item SHALL use the same text as its detail.

#### Scenario: paas up on a busy port
- **WHEN** starting the new `paas-caddy` fails with `PortInUseError` for `127.0.0.1:2019`
- **THEN** `paas up` exits 1, stderr starts `paas: host port 127.0.0.1:2019 is already in use; find what holds it with "ss -ltnp | grep :2019"`, and no `paas-caddy` exists
