---
queue_item: ingress-caddy
queue_hash: sha256:08b52ff495885f6d97e7bf81cdc61fce1119e45822b5ff85b298c588cde45e46
planner: null
date: 2026-09-24
---

Creates capability: `ingress`. Modifies: `deployments`, `app-state`.

### Goal

Apps with a hostname are reachable through a Caddy container that paas manages. paas configures Caddy through its admin API, so routing is a pure function of paas state.

### Context

- Traefik's Docker provider discovers routes by reading the container socket. That would give the proxy root-equivalent access and depend on Podman's socket compatibility. Caddy's admin API accepts an explicit JSON config instead.
- Caddy's admin API has no authentication.

### Requirements

- `paas ingress up` ensures the network `paas-net` and a container named `paas-caddy` from the `caddy:2` image on that network. It publishes the HTTP and HTTPS ports, keeps Caddy's data in a named volume so certificates survive restarts, and publishes the admin API on 127.0.0.1 only. Running it twice changes nothing.
- `paas ingress down` removes the container but keeps the volume. `paas ingress status` reports whether Caddy is running and which routes it serves.
- A pure function turns paas state into Caddy's JSON config: one route per app that has a hostname and a running deployment, proxying to the app's container name and port over `paas-net`.
- TLS mode is `off` by default, serving plain HTTP for local `.localhost` hostnames. In `auto` mode, Caddy obtains certificates for real domains. HTTP and HTTPS host ports default to 80 and 443.
- `paas ingress up` accepts `-tls`, `-http-port` and `-https-port`, and stores them in a settings table added to the state database by a migration.
- When a deployment becomes healthy, paas pushes the new config before the engine removes the previous container, so traffic never points at a removed container. Stopping an app also pushes the config. If a push fails, the deployment stays as it is and the command reports the ingress error.
- Offline tests cover config generation and use a fake admin client. `ingress up` is tested against the fake runtime.
- The integration tier gains a test that routes a hostname to a small HTTP container and fetches it through Caddy.

### Human steps

- Rootless Podman cannot bind ports below 1024 by default. Either allow it with `sysctl net.ipv4.ip_unprivileged_port_start=80`, or bring ingress up with other host ports.

### Non-goals

- Traefik.
- Path-based routing, per-app TLS settings, or load balancing across replicas.

### Notes for planning

- Binding the admin API only to 127.0.0.1 is a requirement in the spec, not an implementation detail.
- The hook into the deployment flow is the only edit to the `deployment-engine` module. Keep it small and name it in the proposal.
