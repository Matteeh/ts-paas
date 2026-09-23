---
title: Change title
depends_on: []
verify: node -e "process.exit(0)"
features:
  reads: []
---
## Goal

What problem this change solves and why.

## Verify

`node -e "process.exit(0)"`

Replace this planning sentinel, here and in the frontmatter, with the command
that verifies the completed change's final tree, and say what it proves.

## Non-goals

- What this change deliberately does not do.

## Surface

<!-- User-facing names this change adds, changes, or removes: commands, flags,
config keys, frontmatter fields, document sections, dead reasons, and event
types. Replace None with one line per name, such as
"- Added: `osq init --refresh-schema` (flag)". -->
None

## Contract

### Requirement: <requirement name>

The system SHALL <observable behavior>.

#### Scenario: <scenario name>
- **WHEN** <condition>
- **THEN** <outcome>

## Human steps

- Review the proposal, delta specs, and task bodies, then run `osq approve <id>`
  yourself.

## Delta

Delta specs live beside the proposal as `specs/<capability>/spec.md`. Each holds
the exact text the capability spec will contain after the change, under
`## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements`,
or `## RENAMED Requirements`; a modified requirement repeats its full text. List
each delta here in one line and name any file two tasks share.

A delta that introduces a new capability also declares the files it owns in a
`### Requirement: Code ownership` block. Its `<!-- source: ... -->` comment lists
the owned path globs, comma-separated, and its scenario restates them:

```markdown
### Requirement: Code ownership
<!-- source: src/core/example.ts, src/cli/example.ts -->
The <capability> capability SHALL own <subsystems>.

#### Scenario: Codebase ownership boundaries
- **WHEN** file ownership is resolved for <capability>
- **THEN** system maps `src/core/example.ts` and `src/cli/example.ts` to <capability>
```
