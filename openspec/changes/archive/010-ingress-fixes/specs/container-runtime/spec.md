# Spec Delta

## MODIFIED Requirements

### Requirement: Integration tier

`pnpm test:integration` SHALL run each `*.itest.ts` file only when `PAAS_INTEGRATION=1`, and otherwise report skipped tests and exit 0. The contract suite SHALL run against the engine socket resolution finds, be labelled `<engine name> (<socket>)`, and use `registry.k8s.io/pause:3.10`. Each file SHALL label what it creates with its own `paas.test` value (`true` for the contract suite) and remove only that, even on failure, because files run in parallel.

#### Scenario: Skipped without the variable
- **WHEN** `pnpm test:integration` runs without `PAAS_INTEGRATION=1`
- **THEN** it reports skipped tests and exits 0

#### Scenario: Suite names the engine
- **WHEN** the integration tier runs against rootless Podman on `/run/user/1000/podman/podman.sock`
- **THEN** the suite is named `container runtime contract: podman (/run/user/1000/podman/podman.sock)`

#### Scenario: Files run in parallel
- **WHEN** the contract suite and the ingress test run at the same time
- **THEN** the contract suite's cleanup removes only `paas.test=true` resources and the ingress test's removes only `paas.test=ingress` ones
