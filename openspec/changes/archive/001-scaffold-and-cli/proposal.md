---
title: Scaffold and CLI skeleton
depends_on: []
verify: pnpm verify
features:
  reads: []
---
## Goal

Turn the repository into a strict TypeScript ESM project with one fast, offline `pnpm verify` and a `paas` CLI that prints its version and help and follows fixed error, exit-code, and `--json` conventions. Every later change builds on this verify, this entry point, and these conventions, so they are fixed now, before any command exists.

Stack: Node 24, ESM, TypeScript 7 (strict), pnpm, commander 15 for argument parsing, and `node:test` run through `tsx`.

## Verify

`pnpm verify`

It typechecks `src/` and `tests/` with `tsc -p tsconfig.json` and runs every `tests/**/*.test.ts` through `node --import tsx --test`. It needs no network, no Docker, and no `dist/`. Before this change the script always fails; after each task it must pass.

## Non-goals

- Any app, state, or container behavior. No `paas` subcommands yet.
- Linters or formatters beyond the TypeScript compiler.
- Bundling. `pnpm build` is plain `tsc`.
- Adding, removing, or upgrading dependencies. A human installs them before approval (see Human steps).

## Surface

- Added: `paas` (binary, runs `dist/cli.js`)
- Added: `paas --version`, `paas -V` (flags)
- Added: `paas --help`, `paas -h` (flags)
- Added: `--json` (flag convention for every command that prints data)
- Added: exit codes 0 success, 1 operation failed, 2 usage error
- Added: `paas: <message>` (error line format on stderr)
- Added: `pnpm verify`, `pnpm test`, `pnpm build` (package scripts)

## Contract

The full contract is the `cli` delta in `specs/cli/spec.md`. In short:

### Requirement: Package and toolchain

The package SHALL be named `ts-paas`, be an ES module package, require Node 24 or later, and expose a `paas` binary that runs `dist/cli.js`. `pnpm verify` SHALL typecheck and run every unit test offline and without `dist/`.

#### Scenario: Verify runs offline from source
- **WHEN** `pnpm verify` runs on a clean checkout with dependencies installed and no `dist/`
- **THEN** it typechecks `src/` and `tests/`, runs every `tests/**/*.test.ts` file, and exits 0 when all pass

### Requirement: Version and help

`paas --version` SHALL print the `package.json` version and exit 0. `paas --help` and bare `paas` SHALL print usage listing every registered command with its one-line description and exit 0.

#### Scenario: Version matches package.json
- **WHEN** a user runs `paas --version`
- **THEN** stdout is exactly the `package.json` version and a newline, and the exit code is 0

### Requirement: Errors and exit codes

Errors SHALL print to stderr as `paas: <message>`. Usage errors SHALL also print usage to stderr and exit 2; operation failures SHALL exit 1.

#### Scenario: Unknown command is a usage error
- **WHEN** a user runs `paas nope`
- **THEN** stderr starts with `paas: `, then contains the usage text, stdout is empty, and the exit code is 2

### Requirement: JSON output convention

Commands that print data SHALL accept `--json` and then print exactly one single-line JSON value and nothing else to stdout, through the shared helper in `src/output.ts`.

#### Scenario: JSON mode prints only JSON
- **WHEN** the output helper is given the value `{"a":1}` in JSON mode
- **THEN** stdout is exactly `{"a":1}` and a newline

## Human steps

- Before approving, install the dependencies at these exact versions (tasks run offline and must not touch the lockfile):
  `pnpm add commander@15.0.0` and then `pnpm add -D typescript@7.0.2 tsx@4.23.15 @types/node@26.6.2`.
  If pnpm warns about ignored build scripts (esbuild, via tsx), no action is needed.
- Review the proposal, the `cli` delta, and both task bodies. Expect the approval digest to flag `sensitive_path` for `package.json` in task 1; that is intended.
- Run `osq approve 001-scaffold-and-cli` yourself.
- After both tasks are done, check the built binary (no task can, because task verifies may not chain commands and no test may depend on `dist/`):
  `pnpm build`, then `node dist/cli.js --version` prints `0.0.0`, and `node dist/cli.js nope` exits 2.

## Delta

- `specs/cli/spec.md`: new `cli` capability (Purpose, package and toolchain, version, help, errors and exit codes, JSON output convention, code ownership).
- No file is shared between tasks. Task 1 owns `package.json` and both tsconfig files, and already points `bin` at `dist/cli.js`, which task 2 creates the source for.
