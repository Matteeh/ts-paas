# ts-paas queue

The first ten changes of ts-paas, the osq test project, as an osq brief queue. Copy this file to `openspec/queue.md` in the ts-paas repository.

Each item's body becomes that change's `brief.md` word for word. Drive the run with `osq plan --next`, then run `/osq-plan <slug>` in Claude Code, review, and `osq approve`. Setup, the bake-off and what to record are in `paas-run-log.md`.

osq reads only the `## [slug]` items below. Everything above the first item is for people.

## [scaffold-and-cli] Scaffold and CLI skeleton

Depends on: nothing

Creates capability: `cli`.

### Goal

The repository becomes a TypeScript project with one fast `pnpm verify` and a `paas` CLI that prints its version and help. Every later change builds on this verify and this CLI.

### Context

- The repository has only what `osq init` wrote, a `package.json` from `pnpm init`, and a placeholder `verify` script that always fails.
- Stack: Node 24, ESM, TypeScript strict, pnpm, commander for argument parsing, and `node:test` run through `tsx`.

### Requirements

- `package.json` names the package `ts-paas`, sets `"type": "module"`, requires Node 24 or later, and exposes a `paas` binary.
- `pnpm verify` typechecks the project and runs every unit test. It needs no network and no Docker.
- `pnpm build` compiles to `dist/`, and the `paas` binary runs from `dist/` when installed. Tests run the CLI from source.
- `paas --version` prints the version from `package.json`.
- `paas --help` lists commands with one-line descriptions.
- An unknown command or bad flag prints usage to stderr and exits with code 2.
- Every error prints as `paas: <message>` on stderr. Exit codes are 0 for success, 1 when the operation failed, and 2 for a usage error.
- Commands that print data accept `-json` and then print only JSON to stdout. This change records the convention in the `cli` capability, and later commands follow it.

### Non-goals

- Any app, state or container behavior.
- Linters or formatters beyond the TypeScript compiler.
- Bundling.

### Notes for planning

- `package.json` and `tsconfig.json` belong to one task.
- Test the CLI in-process or as a child process from source. No test may depend on `dist/`.
- This change creates the `cli` capability, so its delta starts with a `## Purpose` section.

## [runtime-interface] Container runtime interface and fake

Depends on: scaffold-and-cli

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

## [app-state] App state store

Depends on: scaffold-and-cli

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

## [app-management-cli] App management CLI

Depends on: app-state

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

## [deployment-engine] Deployment engine

Depends on: runtime-interface, app-state

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

## [deploy-cli] Deploy, status, logs and stop from the CLI

Depends on: app-management-cli, deployment-engine

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

## [docker-podman-adapter] Docker and Podman adapter

Depends on: runtime-interface

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

## [adapter-engine-fixes] Adapter fixes from the first integration runs

Depends on: docker-podman-adapter

Modifies capability: `container-runtime`.

### Goal

The Docker adapter passes the whole contract suite against real engines. The first integration runs found three contract violations that the offline tests could not see. This change fixes them, writes each one into the spec as a known engine difference, and removes a type-safety workaround left by the adapter change.

### Context

- Results and reproductions are in `docs/integration-testing.md` under "Known results". Docker Engine 24.0.7 (Docker Desktop, WSL 2) passed 11 of 12 contract tests; rootless Podman 3.4.4 (Ubuntu 22.04) passed 10 of 12. Every failure was consistent across runs.
- `tests/support/runtime-contract.ts` declares `networkExists` on the global `Object` interface. Change 007 added this so that three frozen test doubles, the `DelegatingRuntime` classes in `tests/deploy-engine.test.ts`, `tests/deploy-health.test.ts` and `tests/deploy-stop.test.ts`, still typecheck after `ContainerRuntime` gained `networkExists`. Because `tsconfig.json` typechecks `src/` and `tests/` together, every object in `pnpm verify` appears to have that method.

### Requirements

- Docker: right after `stopContainer` returns, Docker's container list can still report the container as `running` while inspect reports `exited`. `listContainers` returns the same state as `inspectContainer` for every container it lists.
- Podman: a pull of a missing image succeeds at the HTTP level and reports the failure as an error event inside the pull stream (`requested access to the resource is denied`, `unauthorized: authentication required`). That becomes `ImageNotFoundError`, using the same message rules as a failed pull response.
- Podman 3.4: creating a container whose name is in use answers HTTP 500 with `that name is already in use`. That becomes `NameConflictError`. A 500 with any other message stays a plain `RuntimeError`.
- Each of the three is written into the `Docker and Podman differences` requirement of the `container-runtime` spec.
- The integration suite is labelled with the engine name from `ping` and the socket, for example `podman (/run/user/1000/podman/podman.sock)`.
- The global `Object` declaration is gone. The three `DelegatingRuntime` doubles delegate `networkExists`, and `pnpm verify` typechecks without the shim.
- Unit tests reproduce each engine behavior with the stubbed dockerode client and run offline in `pnpm verify`.

### Human steps

- After the change lands, run `PAAS_INTEGRATION=1 pnpm test:integration` against Docker and against rootless Podman (`PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock`). Both should pass 12 of 12. Update the "Known results" table in `docs/integration-testing.md`.

### Non-goals

- New engines, remote engines, or new socket locations.
- Changes to the `ContainerRuntime` interface.
- Changes to `deployments` behavior. The three test doubles only gain a delegating method.

### Notes for planning

- Removing the shim modifies three preexisting test files. The task that owns them needs `tests.modify: true`, and the change should say only the `DelegatingRuntime` classes change.
- Before adding or changing any required member of a shared interface, search the tests for `implements ContainerRuntime`.

## [ingress-caddy] Ingress with Caddy

Depends on: deploy-cli, docker-podman-adapter, adapter-engine-fixes

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

## [ingress-fixes] Ingress fixes from the first integration run

Depends on: ingress-caddy

Modifies capabilities: `ingress`, `container-runtime`.

### Goal

`paas ingress up` works against a real Caddy, and the integration tier passes as a whole on Docker and Podman. The first run after change 009 found two bugs that the offline tests could not see. This change fixes both and writes each into the spec.

### Context

- Every request from `HttpCaddyAdmin` in `src/ingress/admin.ts` gets HTTP 403 `{"error":"client is not allowed to access from origin ''"}`. It uses Node's global `fetch`, and fetch always sends `Sec-Fetch-Mode: cors`. Caddy 2.11.4's `admin.go` checks origins whenever a request has an `Origin` or `Sec-Fetch-Mode` header, and then requires an allowed `Origin`. `curl`, which sends neither header, gets 200 from the same container. So `paas ingress up` fails against every real Caddy.
- The offline tests in `tests/ingress-admin.test.ts` use a `node:http` server that accepts any headers, so they passed.
- `node --test` runs `tests/integration/docker.itest.ts` and `tests/integration/ingress.itest.ts` in parallel. Both remove everything labelled `paas.test=true` when they clean up, so each can delete the other's containers while they are still running. In the full run, the contract suite's teardown removed `paas-test-caddy` while the ingress test was pushing to it, and the push failed with ECONNREFUSED.
- A trial fix outside osq swapped `fetch` for `node:http` `request`, then ran the ingress test on its own. It passed on Docker Engine 24.0.7 (8 s) and on rootless Podman 3.4.4 (10.5 s). Podman resolved container names on `paas-net` without extra setup. The trial was reverted.

### Requirements

- `HttpCaddyAdmin` sends no `Origin`, `Referer` or `Sec-Fetch-*` header. It makes its requests with `node:http`, and keeps its URLs, error classes and messages.
- An offline test runs a local `node:http` server that answers 403 like Caddy whenever one of those headers is present. `load` and `getConfig` both succeed against it.
- Each integration file removes only what it created. The two files can run in parallel, and a failure in one leaves the other's resources alone.
- The `ingress` spec's admin client requirement says which headers the client must not send, and why.
- The `container-runtime` spec's integration tier requirement says how integration files keep their resources apart.

### Human steps

- After the change lands, run `PAAS_INTEGRATION=1 pnpm test:integration` against Docker and against rootless Podman (`PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock`). Both files should pass on both engines. Update the "Known results" table in `docs/integration-testing.md`.

### Non-goals

- Any other change to ingress behavior, the config shape, or the CLI.
- New dependencies.

### Notes for planning

- `tests/ingress-admin.test.ts` is a preexisting test. Add the new test in a new file unless an existing assertion depends on `fetch`.
- Changing the label value of the ingress test is enough to keep the two files apart. `DockerRuntime` takes its labels as an option. Serial execution would also work, but it would mean editing `package.json`.

## [reconcile] Reconcile

Depends on: ingress-fixes

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

## [first-real-deploy] First real deploy

Depends on: reconcile

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
