---
queue_item: reconcile
queue_hash: sha256:b49bac042b068893c56f9ee6c9f43393840a57766a8d8e279744f360be4cde67
planner: null
date: 2026-09-24
---

Modifies capability: `deployments`.

### Goal

`paas reconcile` brings stored state and the running engine back into agreement after a crash, a host reboot or manual `docker` commands, and reports every change it made.

### Requirements

- A deployment recorded as running whose container is missing is marked failed with "container disappeared".
- A deployment recorded as running whose container has exited is marked failed with its exit code.
- With `-redeploy`, apps whose running deployment failed in either way are deployed again.
- A container labelled `paas.managed` with no matching running deployment is reported as an orphan. `-prune` removes orphans. The `paas-caddy` container is never an orphan.
- A deployment stuck in pending, pulling or starting for longer than a threshold, ten minutes by default, is marked failed.
- After any change, reconcile pushes the ingress config.
- `-dry-run` prints the actions without taking them. `-json` prints the actions as data.
- `paas status` runs a cheap drift check and prints one warning line when reconcile would change something.
- Offline tests cover each case with the fake runtime and the injected clock.

### Non-goals

- A background loop or daemon.
- Scheduling, or restarts beyond the engine's restart policy.

### Notes for planning

- Write each case as a scenario. They double as the documentation for what reconcile does.
