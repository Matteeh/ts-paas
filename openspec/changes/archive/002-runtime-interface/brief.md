---
queue_item: runtime-interface
queue_hash: sha256:9274748e0ae4eebdfe8de0d8fa8aba049d56d667d3e8a6b9b8b3228b2b069a90
planner: null
date: 2026-09-24
---

Creates capability: `container-runtime`.

### Goal

Everything in paas talks to containers through one `ContainerRuntime` interface. This change defines it, adds an in-memory fake that behaves like a small container engine, and adds a contract test suite that every runtime implementation must pass. No real engine is involved.

### Context

- Later changes build the deployment engine and ingress against this interface. The `docker-podman-adapter` item adds the Docker and Podman implementation, which must pass the same contract suite.

### Requirements

- The interface covers pinging the engine for its name and version, and pulling an image by reference.
- It creates a container from a spec with name, image, environment, labels, network, internal port, restart policy, published ports bound to a host address, and named volumes mounted at paths.
- It starts, stops with a timeout, removes and inspects a container, lists containers by label, reads a container's logs with tail and since options, and ensures a named network or volume exists.
- Inspection returns the container's state as created, running or exited, its exit code, and when it started.
- Failures surface as typed errors: image not found, container not found, name conflict and runtime unavailable. Each keeps the underlying message.
- The fake is deterministic and in memory. Tests can script it: a pull that fails for a given image, a container that exits immediately with a given code, and a container that exits after a delay on an injected clock.
- A contract suite, exported as one function that takes a runtime factory, registers `node:test` tests for every interface operation. `pnpm verify` runs it against the fake.
- Every container paas creates carries the label `paas.managed=true`.

### Non-goals

- dockerode or any real engine.
- Image builds.

### Notes for planning

- Only the adapter from the `docker-podman-adapter` item will ever import dockerode. Keep the interface free of dockerode types.
- The injected clock is its own small interface, so later changes reuse it.
- Published ports and volumes are here because Caddy needs them in the `ingress-caddy` item. Adding them now keeps that change from editing this interface.
