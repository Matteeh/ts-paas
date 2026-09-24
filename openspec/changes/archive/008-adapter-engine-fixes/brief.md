---
queue_item: adapter-engine-fixes
queue_hash: sha256:2ec9c44a462666c812259d68c7f2e35e58666989485678eaf06479cd9eed3695
planner: null
date: 2026-09-24
---

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
