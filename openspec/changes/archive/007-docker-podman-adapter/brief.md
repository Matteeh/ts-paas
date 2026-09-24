---
queue_item: docker-podman-adapter
queue_hash: sha256:87572d9af558371013dad9750300069041b8a1521e28c5763d1d87bd64e4da06
planner: null
date: 2026-09-24
---

Modifies capabilities: `container-runtime`, `cli`.

### Goal

A dockerode-based runtime passes the same contract suite as the fake, against Docker Engine and against rootless Podman, and `paas doctor` tells the user which engine paas will talk to.

### Context

- Podman serves a Docker-compatible API on its socket once `podman.socket` is enabled, so one dockerode client can target both. Some behavior differs, especially networking.
- The contract suite from the `runtime-interface` item takes a runtime factory.

### Requirements

- The socket is resolved in this order, and the first that exists wins: `PAAS_SOCKET`, a `unix://` value in `DOCKER_HOST`, `PODMAN_SOCKET`, `/var/run/docker.sock`, Docker Desktop's `~/.docker/run/docker.sock`, then the rootless Podman socket under `$XDG_RUNTIME_DIR` or `/run/user/<uid>`.
- dockerode errors map to the typed errors. A missing image becomes image not found, a 409 becomes name conflict, and a refused or missing socket becomes runtime unavailable, naming the socket path.
- Pulling waits for the whole pull stream to finish.
- Logs from containers without a TTY are split correctly into stdout and stderr.
- `paas doctor` prints the socket, the engine name and version, the API version, and whether `paas-net` exists. It exits 1 when the engine is unreachable.
- The CLI's runtime factory uses this adapter by default, and tests keep using the fake.
- Unit tests stub the dockerode client and run offline in `pnpm verify`.
- `pnpm test:integration` runs the contract suite against the real engine when `PAAS_INTEGRATION=1`, using a small public image. It labels everything it creates with `paas.test=true` and removes those resources afterwards, even when a test fails. Without the variable it prints that it skipped and exits 0.

### Human steps

- Run `PAAS_INTEGRATION=1 pnpm test:integration` against Docker.
- On Linux, enable rootless Podman with `systemctl --user enable --now podman.socket` and run it again. Record any contract differences in the change's results.

### Non-goals

- Remote engines over TCP or SSH.
- TLS to the engine.
- The build API.

### Notes for planning

- This is the only module that imports dockerode. Add `dockerode` and `@types/dockerode`, and check that the types match the installed major version.
- Where Docker and Podman differ, write it into the spec rather than special-casing it silently.
