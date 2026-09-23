# Spec Delta

## Purpose

The `cli` capability is the `paas` command-line entry point: how the package is built and installed, how arguments are parsed, and the output, error, and exit-code conventions every `paas` command follows.

## ADDED Requirements

### Requirement: Package and toolchain

The package SHALL be named `ts-paas`, be an ES module package, require Node 24 or later, and expose a `paas` binary that runs `dist/cli.js`. `pnpm verify` SHALL typecheck the project and run every unit test without network access, Docker, or a built `dist/`. `pnpm build` SHALL compile `src/` to `dist/`.

#### Scenario: Verify runs offline from source
- **WHEN** `pnpm verify` runs on a clean checkout with dependencies installed and no `dist/`
- **THEN** it typechecks `src/` and `tests/`, runs every `tests/**/*.test.ts` file, and exits 0 when all pass

#### Scenario: Built binary runs from dist
- **WHEN** `pnpm build` runs and then `node dist/cli.js --version` runs
- **THEN** the version from `package.json` prints to stdout and the process exits 0

### Requirement: Version output

`paas --version` and `paas -V` SHALL print the `version` field of `package.json` followed by a newline to stdout and exit 0.

#### Scenario: Version matches package.json
- **WHEN** a user runs `paas --version`
- **THEN** stdout is exactly the `package.json` version and a newline, stderr is empty, and the exit code is 0

### Requirement: Help output

`paas --help`, `paas -h`, and `paas` with no arguments SHALL print usage to stdout and exit 0. The help SHALL list every registered command with its one-line description. Every registered command SHALL have a non-empty one-line description.

#### Scenario: Help lists usage and commands
- **WHEN** a user runs `paas --help`
- **THEN** stdout starts with `Usage: paas`, includes the name and description of every registered command, and the exit code is 0

#### Scenario: No arguments prints help
- **WHEN** a user runs `paas` with no arguments
- **THEN** stdout is the same help text as `paas --help` and the exit code is 0

#### Scenario: Every command is described
- **WHEN** the program's registered commands are listed
- **THEN** each has a description that is non-empty and a single line

### Requirement: Error format and exit codes

Every error SHALL print to stderr as one line starting with `paas: ` followed by the message. `paas` SHALL exit 0 on success, 1 when the operation failed, and 2 on a usage error. An unknown command, an unknown option, a missing or extra argument, or a thrown `UsageError` SHALL be a usage error: `paas: <message>` and then the usage text print to stderr, and nothing prints to stdout. Any other thrown error SHALL be an operation failure: only `paas: <message>` prints to stderr.

#### Scenario: Unknown command is a usage error
- **WHEN** a user runs `paas nope`
- **THEN** stderr starts with `paas: `, then contains the usage text, stdout is empty, and the exit code is 2

#### Scenario: Unknown option is a usage error
- **WHEN** a user runs `paas --bogus`
- **THEN** stderr starts with `paas: ` and mentions `--bogus`, then contains the usage text, stdout is empty, and the exit code is 2

#### Scenario: Operation failure exits 1
- **WHEN** a command action throws an error that is not a `UsageError`, with message `boom`
- **THEN** stderr is exactly `paas: boom` and a newline, and the exit code is 1

### Requirement: JSON output convention

Every command that prints data SHALL accept `--json`. With `--json`, the command SHALL print exactly one JSON value, serialized on a single line and followed by a newline, to stdout and nothing else to stdout. Without `--json`, the command SHALL print its human-readable form. Errors SHALL follow the error format and exit codes whether or not `--json` is given. Commands SHALL produce data output through the shared output helper in `src/output.ts`.

#### Scenario: JSON mode prints only JSON
- **WHEN** the output helper is given the value `{"a":1}` in JSON mode
- **THEN** stdout is exactly `{"a":1}` and a newline

#### Scenario: Human mode uses the formatter
- **WHEN** the output helper is given a value and a formatter in human mode
- **THEN** stdout is the formatter's text followed by one newline, and no JSON prints

### Requirement: Code ownership
<!-- source: src/cli.ts, src/program.ts, src/errors.ts, src/output.ts, src/version.ts -->
The cli capability SHALL own the `paas` entry point, program construction and argument parsing, error types, the shared output helper, and version lookup.

#### Scenario: Codebase ownership boundaries
- **WHEN** file ownership is resolved for cli
- **THEN** system maps `src/cli.ts`, `src/program.ts`, `src/errors.ts`, `src/output.ts`, and `src/version.ts` to cli
