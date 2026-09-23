---
queue_item: scaffold-and-cli
queue_hash: sha256:8efb2414cf80ffa5be263e49280ec627bc29634b168a94339ffac0ed16aecfed
planner: null
date: 2026-09-23
---

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
