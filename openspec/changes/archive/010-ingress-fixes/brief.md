---
queue_item: ingress-fixes
queue_hash: sha256:1f62c12ea395669a7bd7f64324fcfbc9ed17ddfe07028353824163f1df1cc1a8
planner: null
date: 2026-09-24
---

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
