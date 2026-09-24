---
title: First real deploy
depends_on: ["011"]
verify: pnpm verify
features:
  reads: []
---
## Goal

On a fresh machine with Docker or rootless Podman, a user runs `paas up`, creates an app from a public image, deploys it, opens it at its hostname, redeploys with no downtime, reads its logs and stops it. This is the first useful version, 0.1.0.

This change adds `paas up`, a `pnpm test:e2e` tier that runs that whole flow against a real engine and a real Caddy, and a README quickstart. It also fixes a gap the manual walkthrough (`docs/manual-testing.md`) found: `paas reconcile --redeploy` now brings back apps that an earlier reconcile run already failed.

## Verify

`pnpm verify`

It typechecks `src/` and `tests/`, including the new end-to-end file, and runs every unit test offline: `paas up` on the fake runtime with a fake admin client, the reconcile redeploy rule, and the release checks on `package.json`. After each task it must pass. The end-to-end run against a real engine is a human step.

## Non-goals

- Builds from git, a registry, an HTTP API, the dashboard, authentication, or several hosts.
- A `paas down` command. The flow ends with `paas stop` and `paas ingress down`.
- Running the end-to-end test in `pnpm verify` or CI.
- A new test for "no pushed config ever points at a removed container". `tests/ingress-deploy-cli.test.ts` has covered it since change 009.

## Surface

- Added: `paas up` (command) with `--tls <off|auto>`, `--http-port <n>`, `--https-port <n>` (flags)
- Added: `pnpm test:e2e` (script) and the `PAAS_E2E` environment variable
- Changed: `paas reconcile --redeploy` also redeploys apps that an earlier run failed
- Changed: `paas --version` prints `0.1.0`
- Added: README section "Quickstart"

## Contract

The full contract is in `specs/cli/spec.md`. In short:

### Requirement: Up command

`paas up` SHALL ping the engine, ensure `paas-net`, bring ingress up, print the doctor lines and the ingress line, and print the next command to run.

#### Scenario: Fresh machine
- **WHEN** a user runs `paas up` on an engine without `paas-net` or `paas-caddy`
- **THEN** it prints `paas-net: present` among the doctor lines, `ingress is up (created): ...`, and a `next: paas apps create ...` line, and exits 0

### Requirement: Reconcile redeploy and ingress

`--redeploy` SHALL redeploy every app with no running deployment whose latest deployment reached `running` and was then marked `failed`, whichever run failed it.

#### Scenario: Failed by an earlier run
- **WHEN** a plain `paas reconcile` failed `web` because its container disappeared, and a user then runs `paas reconcile --redeploy`
- **THEN** stdout has `redeploy: web (deployment <new id> is running)`

## Human steps

- Review the proposal, the `cli` delta and the three task bodies. Expect the approval digest to flag `sensitive_path` for `package.json` in task 3, which adds the `test:e2e` script and sets the version to `0.1.0`. No dependency changes, so no lockfile change.
- Run `osq approve 012-first-real-deploy` yourself.

After the change lands:

- Run `PAAS_E2E=1 pnpm test:e2e` against Docker. It needs no existing `paas-caddy`, it uses host ports 28080 and 28443, and it binds the admin API on `127.0.0.1:2019`. Stop any real paas ingress first.
- Run it on Linux with rootless Podman: `PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock PAAS_E2E=1 pnpm test:e2e`.
- Follow the new README quickstart once by hand, on the default ports if your engine allows them.
- Optionally point a wildcard DNS record at a server, run `paas up --tls auto`, and deploy with a real hostname.
- Record the results in `docs/integration-testing.md` under "Known results".

## Delta

- `specs/cli/spec.md`: adds "Up command" and "End-to-end tier"; modifies "Reconcile redeploy and ingress" (redeploy rule). The brief lists `deployments` too, but no deployment engine behavior changes: the redeploy rule lives in `src/commands/reconcile.ts`, which `cli` owns.
- The brief's redeploy rule matched deployment errors (`container exited with code <n>` and the like). A deploy that fails its health window stores an error that starts `container exited with code <n>` too, so that rule would redeploy crashing apps on every `--redeploy`. This change uses status history instead: only reconcile moves a deployment from `running` to `failed`.
- No file is shared between tasks. Task 1 owns `src/commands/reconcile.ts`; task 2 owns `src/commands/up.ts`, `src/commands/ingress.ts` and `src/program.ts`; task 3 owns `tests/e2e/first-deploy.e2e.ts`, `tests/release.test.ts`, `package.json` and `README.md`.
- The brief expected at most two small tasks. This change has three because the reconcile fix, found after the brief was written, is its own unit. Nothing earlier was missing for `paas up`.
