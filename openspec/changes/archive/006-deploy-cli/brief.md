---
queue_item: deploy-cli
queue_hash: sha256:5e3d259caed4e43b489e28ba5dba0d664bd049206aaa644c413f409410c1055e
planner: null
date: 2026-09-24
---

Modifies capability: `cli`. Reads: `deployments`.

### Goal

Users drive deployments from the CLI with live progress, and can inspect status and logs.

### Requirements

- `paas deploy <app>` runs the engine, prints each progress step, and exits 0 when the deployment is running, or 1 with the error when it fails. `-image <ref>` updates the app's image first.
- `paas status` shows each app's latest deployment status, short container id, image and uptime. `paas status <app>` shows one app and its last five deployments. Both accept `-json`.
- `paas logs <app>` prints the running container's logs, with `-tail <n>` and `-since <duration>`.
- `paas stop <app>` stops the app.
- The CLI gets its runtime from one factory. Tests get the fake from it. Until the `docker-podman-adapter` item adds the real adapter, commands that need a runtime fail outside tests with a message that no container runtime is configured yet.
- Tests run the commands in-process against one fake runtime and a temporary `PAAS_HOME`.

### Non-goals

- A real runtime.
- Following logs as they are written.

### Notes for planning

- Reuse the command registration pattern from the `app-management-cli` item.
