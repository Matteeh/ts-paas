---
title: Ingress fixes from the first integration run
depends_on: ["009"]
verify: pnpm verify
features:
  reads: []
---
## Goal

`paas ingress up` works against a real Caddy, and the integration tier passes as a whole on Docker and Podman. The first integration run after change 009 found two bugs that the offline tests could not see:

- Caddy's admin API answers 403 to every request from `HttpCaddyAdmin`. Node's global `fetch` always sends `Sec-Fetch-Mode: cors`, and Caddy 2.11.4 then requires an allowed `Origin`. Every real `paas ingress up`, deploy push and status read fails.
- The two integration files each remove everything labelled `paas.test=true`. `node --test` runs them in parallel, so the contract suite's teardown deleted `paas-test-caddy` in the middle of the ingress test.

A trial fix, `node:http` in place of `fetch`, made the ingress test pass on Docker Engine 24.0.7 and on rootless Podman 3.4.4. This change makes that fix properly and keeps the two files' resources apart.

## Verify

`pnpm verify`

It typechecks `src/` and `tests/` and runs every unit test offline. A new admin client test runs against a local server that rejects browser headers the way Caddy does, and a new hygiene test checks that the ingress integration file uses its own label. After each task it must pass. The real run of both integration files is a human step.

## Non-goals

- Any other change to ingress behavior, the config shape, or the CLI.
- New dependencies, or changes to `package.json`, including running the integration tier serially.
- Changes to the runtime contract suite or `tests/integration/docker.itest.ts`.

## Surface

- Changed: the label on everything `tests/integration/ingress.itest.ts` creates, now `paas.test=ingress` instead of `paas.test=true`

## Contract

The full contract is in `specs/ingress/spec.md` and `specs/container-runtime/spec.md`. In short:

### Requirement: Admin client

`HttpCaddyAdmin` SHALL send no `Origin`, `Referer` or `Sec-Fetch-*` header, because Caddy's admin API enforces origins whenever one is present.

#### Scenario: Server that enforces origins
- **WHEN** the admin API answers 403 to any request carrying `Origin`, `Referer` or a `Sec-Fetch-*` header
- **THEN** `load` and `getConfig` both succeed

### Requirement: Integration tier

Each integration file SHALL label what it creates with its own `paas.test` value and remove only that.

#### Scenario: Files run in parallel
- **WHEN** both integration files run at once
- **THEN** neither removes a resource the other created

## Human steps

- Review the proposal, both deltas and both task bodies. Expect the approval digest to flag `tests.modify` for task 2, which changes only the label value in `tests/integration/ingress.itest.ts`.
- Run `osq approve 010-ingress-fixes` yourself.

After the change lands:

- Run `PAAS_INTEGRATION=1 pnpm test:integration` against Docker, and against rootless Podman with `PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock`. Both files should pass on both engines: 12 of 12 contract tests plus the ingress test.
- Update the "Known results" table in `docs/integration-testing.md`, including that Podman 3.4.4 resolved container names on `paas-net` without the `dnsname` step, if that holds.

## Delta

- `specs/ingress/spec.md`: modifies "Admin client" (no browser headers, sent with `node:http`). Its existing scenario is kept.
- `specs/container-runtime/spec.md`: modifies "Integration tier" (each file uses its own `paas.test` value and removes only that). Its existing scenarios are kept.
- No file is shared between tasks. Task 1 owns `src/ingress/admin.ts` and the new `tests/ingress-admin-headers.test.ts`. Task 2 owns `tests/integration/ingress.itest.ts`, `docs/integration-testing.md` and the new `tests/integration-isolation.test.ts`.
