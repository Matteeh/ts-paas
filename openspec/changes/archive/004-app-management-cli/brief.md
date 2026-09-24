---
queue_item: app-management-cli
queue_hash: sha256:686b381451b8ead787980a0701e1d94bb66f56030a2d153396e6329c60fcf46e
planner: null
date: 2026-09-24
---

Modifies capability: `cli`. Reads: `app-state`.

### Goal

Users create, list, inspect, update and delete apps from the CLI. Nothing runs yet.

### Requirements

- `paas apps create <name> --image <ref> --port <n>` creates an app, with optional `-host <hostname>` and repeatable `-env KEY=VALUE`.
- `paas apps list` prints a table of name, image, port, host and latest deployment status. `-json` prints an array.
- `paas apps show <name>` prints one app with its environment variable names. Values are masked unless `-reveal` is passed, and `-json` follows the same masking.
- `paas apps set <name>` changes the image, port or host, adds or replaces variables with `-env`, and removes them with `-unset-env KEY`.
- `paas apps delete <name>` deletes an app that has no running deployment. Otherwise it fails with a message saying to stop the app first.
- Validation errors name the field and exit with code 2. Operations that fail, such as creating an app that already exists, exit with code 1.
- Tests run the commands against a temporary `PAAS_HOME`.

### Non-goals

- Deploying, stopping, or anything that touches containers.
- Reading environment variables from files.

### Notes for planning

- Each subcommand lives in its own file. One task owns the file that registers commands, so later tasks don't all edit it. If tasks must share it anyway, say so in the proposal.
