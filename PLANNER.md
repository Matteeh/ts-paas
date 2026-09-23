# Planning a change for osq

<!-- OSQ:START -->
## Planning a change

You write the change folder; a cheaper executor runs it one task at a time,
sees only what you wrote, and reads it literally.

### Interactive planning

When a human is in the session:

1. Read `AGENTS.md`, the capability specs this change touches, and one recent
   archived change end to end.
2. Reply with the parent spec, the task list (titles only), the capability specs
   this change will write, and any `## Human steps`. Stop there.
3. Write the change folder only after the human approves the list.

### Working from the handoff

When `osq plan` started you, `plan-prompt.md` in the selected change folder is
your complete prompt; read it and follow it exactly.

### Either way

- Write only inside that change folder.
- Run `osq lint <slug>` and fix every finding before you finish.
- Never run `osq approve`; a human owns that gate.
- Grep for what already exists; verify every version, flag, or API before use.
- Write files with the file tool, never through a shell echo.

### Tasks

- One task per coherent unit. Title is "When X, Y".
- Every task names its `scope` and `verify` (no TTY, no network). A task that changes a preexisting
  test sets `tests.modify: true` and lists that test in `scope`; every other preexisting test is
  frozen. `osq lint` enforces the configured limits on scope patterns and acceptance lines.
- `osq init` and `osq new` seed `verify: node -e "process.exit(0)"` as a
  planning sentinel, not trusted coverage. `osq lint` rejects it; replace it
  before approval with a command that verifies the completed change's final tree.
- Every task's `verify` exercises its slice through the real entry point, wiring included. If closing
  the loop requires a file outside the task's `scope`, the scope is wrong; widen it or merge the task.
  An executor result that says the work is outside its scope is a planning failure.
- Every task's `verify` must stay re-runnable against the final tree of the
  completed change, because the watcher and archive recertification run it there after
  later tasks land. A command that passes only mid-change is a planning failure.
- By default the watcher also runs the change-level `verify` after each task, and
  a red result kills that task. Every task must leave it green; tasks that pass
  only together are one task.
- The watcher runs each task's `verify` once before the first attempt and expects
  it to fail. A task whose `verify` should already pass before any change, such as
  a refactor, declares `verify_starts: green`. A task whose `verify` names a test
  the task creates declares `verify_starts: red`; a new test file may share that
  verify with existing tests. `any` is only for a task that can honestly start
  either way.
- A file belongs to one task. Before each later task, the watcher re-hashes the
  resolved `scope` of every done task; any change halts the change until a human
  runs `osq retry`. Globs resolve again at every audit, so a broad glob also
  captures files that later tasks create. When a later task must extend a file,
  order that later task after the owner, name the shared file in the proposal,
  and list the expected `osq retry` under `## Human steps`.
- Task bodies carry acceptance lines and the names of existing code to reuse,
  without signature blocks, numbered implementation steps, or line numbers. Write
  full signatures only for ports.
- Refer to functions and files by name, never by line number.

### Parent spec

- `## Goal`, then the change-level `verify` every proposal declares as the first
  thing written after the goal, then `## Non-goals` and the contract as
  requirements with scenarios.
- `## Surface` follows `## Non-goals` and lists the user-facing names the change
  adds, changes, or removes: commands, flags, config keys, frontmatter fields,
  document sections, dead reasons, and event types. Write `None` when there are
  none; `osq lint` rejects a proposal without the section.
- The delta is the exact text the capability spec will contain after the change,
  never an instruction to update something.
- Anything a task must not do itself goes under `## Human steps`.
<!-- OSQ:END -->
