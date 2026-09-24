---
queue_item: deployment-engine
queue_hash: sha256:8d3269f7db552201f588972fe8a246276647ce62079794c630676005ca688d8d
planner: null
date: 2026-09-24
---

Creates capability: `deployments`. Reads: `container-runtime`, `app-state`.

### Goal

One function takes an app from its stored spec to a running container through the runtime interface, records every status change, and never takes down an app's working container when a new deployment fails. All of it is proven against the fake runtime.

### Requirements

- A deployment moves through pending, pulling, starting and running, and the store records each step.
- The new container is named after the app plus a short deployment id, carries the labels `paas.managed`, `paas.app` and `paas.deployment`, joins the network `paas-net`, and uses the restart policy unless-stopped.
- Health means the container stays running for a configurable window, three seconds by default, measured on the injected clock. If it exits inside the window, the deployment fails with the exit code and the last 20 log lines.
- Once the new container is healthy, the deployment is marked running. Only then does the engine stop and remove the previous deployment's container and mark that deployment replaced.
- If the pull fails, the deployment fails and no container is created.
- If the new container fails its health window, the engine removes it and the previous deployment stays running.
- A runtime error at any step fails the deployment with the runtime's message, and nothing that was running before stops.
- A second deploy of an app while one is in progress is refused.
- Stopping an app stops and removes its running container and marks the deployment stopped.
- The engine reports progress through a callback, so the CLI can print it.
- Tests use the fake runtime and the injected clock. No test sleeps for real.

### Non-goals

- TCP or HTTP health checks.
- Several replicas per app.
- A rollback command.
- Updating ingress. The `ingress-caddy` item hooks into this flow.

### Notes for planning

- Write the deployment flow as scenarios in the `deployments` delta. They are the most useful part of this change to review.
- One module owns the flow. Pass the callback and the clock in as parameters, never as globals.
