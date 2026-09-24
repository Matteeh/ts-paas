---
queue_item: first-real-deploy
queue_hash: sha256:c9a622e6f778f8170688e24a771f44164a653818a72eb1bd3b27a5dc23a1c30d
planner: null
date: 2026-09-24
---

Modifies capabilities: `cli`, `deployments`.

### Goal

On a fresh machine with Docker or rootless Podman, a user runs `paas up`, creates an app from a public image, deploys it, opens it at its hostname, redeploys with no downtime, reads its logs and stops it. This is the first useful version.

### Context

- The manual walkthrough in `docs/manual-testing.md` (Docker 24.0.7, rootless Podman 3.4.4) found that `paas reconcile --redeploy` only redeploys apps that the same run marks failed. After a plain `paas reconcile` has already failed an app whose container disappeared or stopped, a later `--redeploy` does nothing, and the app stays down until `paas deploy`.
- A host port already in use makes `paas ingress up` fail with `port is already allocated` and leaves `paas-caddy` created but not running. Running it again with free ports recovers (`recreated`).

### Requirements

- `paas reconcile --redeploy` also redeploys apps that an earlier run failed: every app with no running deployment whose latest deployment failed with `container disappeared`, `container exited with code <n>` or `container is not running`.
- `paas up` runs the doctor checks, ensures `paas-net`, brings ingress up, and prints the next command to run.
- `pnpm test:e2e` runs the full flow when `PAAS_E2E=1`:
  - bring paas up
  - create an app with host `whoami.localhost` from the `traefik/whoami` image and deploy it
  - fetch it through Caddy by sending the Host header to the local HTTP port, so the test doesn't depend on name resolution
  - redeploy with a changed environment variable, fetch again and see the change
  - read the logs, stop the app and bring paas down
- The end-to-end test removes every paas-labelled resource it created, even on failure. Without the variable it skips and exits 0.
- The README gets a quickstart for Docker Desktop and for rootless Podman on Linux, including the low-port caveat and how `.localhost` hostnames resolve.
- `paas --version` reports 0.1.0.

### Human steps

- Run `PAAS_E2E=1 pnpm test:e2e` against Docker.
- Run it on a Linux host with rootless Podman.
- Optionally point a wildcard DNS record at a server, bring ingress up with `--tls auto`, and deploy with a real hostname.

### Non-goals

- Builds from git, a registry, an HTTP API, the dashboard, authentication, or several hosts.

### Notes for planning

- The redeploy test that asserts no pushed config ever points at a removed container already exists in `tests/ingress-deploy-cli.test.ts` (change 009). Reuse it rather than adding another.
- `src/commands/reconcile.ts` passes each item's container name through a module-level `WeakMap` because the `ReportItem` port has no field for it (change 011). If the reconcile task touches that file anyway, give `ReportItem` a name field that the JSON output leaves out.
- Most of this change is wiring and verification. If the code grows beyond two small tasks, something earlier was missing. Say so in the proposal.
