---
queue_item: ingress-resilience
queue_hash: sha256:54ea37d4b4c5fb6968dd8c2fa512f31c562b8941236e05df61a6b2cc2e1165a9
planner: null
date: 2026-09-24
---

Modifies capabilities: `container-runtime`, `ingress`, `cli`.

### Goal

paas notices when Caddy is not running and brings it back, and a host port that is already in use produces a clear error instead of a raw engine message. Both came up in the first end-to-end runs on rootless Podman 3.4.4. The root cause is a Podman bug that paas cannot fix, so this change makes paas resilient to it and documents it.

### Context

Observed on rootless Podman 3.4.4 (Ubuntu 22.04 on WSL 2), with `paas-caddy` publishing ports, on 2026-09-24:

| Action on `paas-caddy` | Result |
|---|---|
| `paas ingress up`, then `paas ingress down` (API socket only) | Clean: the port forwarder exits with the container. |
| `paas ingress up` with changed ports (recreate path) | Clean. |
| Caddy killed (`podman kill --signal KILL`) | Stays `Exited (137)`. Rootless Podman 3.4 does not apply the `unless-stopped` restart policy, so every route is down. `paas status` and `paas reconcile` say nothing. |
| `podman restart` or `podman stop` then `podman start` while running | Fails with `rootlessport listen tcp 0.0.0.0:<port>: bind: address already in use`. |
| Any container the `podman` CLI started, later stopped or removed by any means | Its `containers-rootlessport` process keeps listening on the published ports, with no container behind it. |

- A leaked forwarder blocks every later `paas ingress up` on those ports. On WSL 2 it also blocks Docker Desktop, because Windows relays WSL's localhost ports. In change 012's first e2e run, Docker failed with `Ports are not available: exposing port TCP 127.0.0.1:2019 ... bind: Only one usage of each socket address`.
- Docker reports a busy port as `driver failed programming external connectivity ... Bind for 0.0.0.0:<port> failed: port is already allocated`, or as `Ports are not available: exposing port TCP <addr> ...`. Podman reports it as `rootlessport listen tcp <addr>: bind: address already in use`.
- When the start of a new `paas-caddy` fails, `paas ingress up` leaves the container in state `created`. `syncIngress` then skips every push without a word.
- `docs/manual-testing.md` step 3 tells the reader to run `docker restart paas-caddy`, which on Podman 3.4 triggers the failure above.

### Requirements

- `paas reconcile` reports a `paas-caddy` that exists but is not running, starts it, and then pushes the config. `--dry-run` only plans it, and `paas status` counts it in its drift warning.
- The Docker adapter maps a failed start whose message says `address already in use`, `port is already allocated` or `Ports are not available` to a new typed error, `PortInUseError`, keeping the engine's message.
- When `paas ingress up`, `paas up` or reconcile cannot start Caddy because a port is in use, the error names the host port and says how to find what holds it (`ss -ltnp`). On rootless Podman it also says the holder may be a leftover `containers-rootlessport` process.
- When `ingressUp` creates `paas-caddy` and cannot start it, it removes that container again, so no half-created `paas-caddy` stays behind.
- The `container-runtime` spec's `Docker and Podman differences` requirement records that rootless Podman 3.4 does not apply restart policies and can leak port forwarders for containers the `podman` CLI started.
- Offline tests cover each case with the fake runtime and the stubbed dockerode client.

### Human steps

- After the change lands, on rootless Podman: bring ingress up with `paas up`, run `podman kill --signal KILL paas-caddy`, and check that `paas status` warns and `paas reconcile` brings Caddy and its routes back. Then hold a port (for example `python3 -m http.server 28080`) and check that `paas up --http-port 28080` explains itself and leaves no `paas-caddy`.
- Update the "Known results" table in `docs/integration-testing.md` with the change 012 e2e runs and this one.

### Non-goals

- Killing leaked `containers-rootlessport` processes automatically. paas does not manage host processes.
- A background watchdog. Reconcile stays something the user runs.
- Restarting app containers that stopped. Reconcile already fails their deployments, and `--redeploy` brings them back.

### Notes for planning

- `docs/manual-testing.md` step 3 must stop recommending `podman restart`. On Podman, simulate a crash with `podman kill --signal KILL paas-caddy` instead, which tests the new reconcile case. Add a short "Podman 3.4 port forwarders" section on finding and stopping a leaked forwarder, and link it from the README quickstart's Podman subsection.
- Adding `PortInUseError` adds a class, not an interface member. Before changing error mapping, grep the tests for assertions on the plain `RuntimeError` for these messages.
