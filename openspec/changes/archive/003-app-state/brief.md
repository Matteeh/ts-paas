---
queue_item: app-state
queue_hash: sha256:d0d992b6faaf4e8147c5c3edc8db6599b4d28cfa52c022a124aab59728634a14
planner: null
date: 2026-09-24
---

Creates capability: `app-state`.

### Goal

paas remembers apps and their deployments in a local SQLite database, with versioned migrations and a small repository API that tests can run against an in-memory database.

### Context

- `node:sqlite` ships with Node and needs no native build step. It prints an experimental warning on first use.

### Requirements

- The store uses `node:sqlite`. The CLI suppresses the experimental warning so it never appears in normal output.
- The database lives at `$PAAS_HOME/state.db`, defaulting to `~/.paas/state.db`, and is created on first use.
- Migrations are numbered, applied in order in a transaction when the database opens, and recorded in a schema version table. Opening a database newer than the code knows fails with a clear message.
- Apps have a name, image reference, internal port, optional hostname, environment variables, and created and updated timestamps.
- Deployments have an id, the app name, the image reference, a status, the container id, an error message, and created and finished timestamps.
- Deployment status is one of pending, pulling, starting, running, failed, stopped or replaced. Every status change records when it happened.
- Repository functions cover creating, reading, listing, updating and deleting apps, and creating deployments, changing their status, and reading an app's latest deployment and its history.
- The repository validates at its boundary. App names are lowercase letters, digits and hyphens, 1 to 40 characters, starting with a letter. Ports are 1 to 65535. Hostnames are valid DNS names.
- Deleting an app with a running deployment fails.
- Tests use in-memory databases.

### Non-goals

- Postgres.
- Several processes writing at once. One CLI process at a time is the assumption until an API server exists.

### Notes for planning

- Keep all SQL in the store module.
- Store timestamps as ISO 8601 strings.
