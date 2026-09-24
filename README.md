# ts-paas

A small self-hosted platform-as-a-service. The goal: on one machine with Docker or rootless Podman, `paas` deploys container images as apps, routes each app's hostname to it through a managed Caddy, redeploys without downtime, and shows status and logs.

The project also tests a spec-driven workflow built on [osq](https://www.npmjs.com/package/@matteeh/osq) (see [How changes are made](#how-changes-are-made)).

## Status

Work in progress. `paas` can manage apps (`paas apps`), deploy them with health checks and zero-downtime replacement (`paas deploy`, `status`, `logs`, `stop`), and report the engine it talks to (`paas doctor`), on Docker or Podman through the Docker-compatible socket. It routes each app's hostname through a managed Caddy (`paas ingress`) and repairs drift between its state and the engine (`paas reconcile`). `paas up` is still to come. See the [roadmap](#roadmap).

## Requirements

- Node.js 24 or later
- pnpm 12

## Development

```sh
pnpm install
pnpm verify   # typecheck and run every unit test; needs no network or Docker
pnpm build    # compile src/ to dist/
node dist/cli.js --help
```

Tests use `node:test` through `tsx` and run the CLI from source. No test depends on `dist/`.

`pnpm test:integration` runs the runtime contract suite against a real Docker or Podman engine when `PAAS_INTEGRATION=1` is set; without it, it skips. See [docs/integration-testing.md](docs/integration-testing.md) for setup (including WSL), engine selection, cleanup, and known engine differences.

[docs/manual-testing.md](docs/manual-testing.md) walks through breaking a deployed app on a real engine (a removed container, a Caddy restart, a stopped container) and checking that `paas status` warns and `paas reconcile` repairs it.

### CLI conventions

Every `paas` command follows these rules:

- Errors print to stderr as `paas: <message>`.
- Exit codes: `0` success, `1` the operation failed, `2` usage error (unknown command or option, bad arguments).
- Commands that print data accept `--json` and then print exactly one line of JSON to stdout.

The full contract is in [openspec/specs/cli/spec.md](openspec/specs/cli/spec.md).

## How changes are made

Work arrives as a queue of briefs in [openspec/queue.md](openspec/queue.md). For each brief:

1. A planner agent turns the brief into a change folder under `openspec/changes/`. The folder holds a proposal, delta specs, and small tasks, each with a `scope` and a `verify` command.
2. A human reviews the folder and runs `osq approve`.
3. `osq watch` hands each task to a coding agent. The watcher runs each task's `verify` itself before marking it done.
4. When every task is done, osq applies the delta specs to the living specs in `openspec/specs/` and archives the change under `openspec/changes/archive/`.

[AGENTS.md](AGENTS.md) and [PLANNER.md](PLANNER.md) hold the rules the agents follow.

## Roadmap

The queued changes, in dependency order:

1. **Scaffold and CLI skeleton** (done): TypeScript toolchain, `pnpm verify`, and the `paas` entry point.
2. **Container runtime interface** (done): one `ContainerRuntime` interface, an in-memory fake, and a contract test suite.
3. **App state store** (done): apps and deployments in local SQLite, with migrations.
4. **App management CLI** (done): create, list, inspect, update, and delete apps.
5. **Deployment engine** (done): deploy from the stored spec, and never take down a working container when a new deployment fails.
6. **Deploy CLI** (done): deploy, status, logs, and stop, with live progress.
7. **Docker and Podman adapter** (done): a real runtime that passes the same contract suite, plus `paas doctor`. Integration results so far are in [docs/integration-testing.md](docs/integration-testing.md#known-results).
8. **Ingress with Caddy** (done): hostname routing through a Caddy container that paas configures.
9. **Reconcile** (done): `paas reconcile` makes stored state and the engine agree again after a crash, a reboot, or manual changes.
10. **First real deploy**: `paas up` and an end-to-end flow on Docker and rootless Podman.

## License

[MIT](LICENSE)
