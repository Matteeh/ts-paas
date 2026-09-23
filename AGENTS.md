# AGENTS

<!-- OSQ:START -->
## Executing a task

You were handed one task, `tasks/<n>.md`, from a change under `openspec/changes/`.

1. Read your task file, its parent `proposal.md`, then only the delta specs and capability specs it names. Nothing else.
2. Too big for one pass? Write why in `.run/results/<n>.md`, exit without code.
3. Read a previous result file for this task if present. Run the task's `verify`. Start from what fails.
4. Tests for each acceptance line before implementing.
5. Minimal code to pass. Write only `.run/results/<n>.md` and files inside the task's `scope`; the task's `scope` wins over any other ownership rule you were given.
6. New test files are always allowed. Change a preexisting test only when the task sets `tests.modify: true` and the file is inside `scope`; any other test change kills the task.
7. Run the task's `verify` command before exiting. Then run the proposal's `verify`; the watcher runs both itself and kills the task if either fails.

## Exiting

Write `.run/results/<n>.md` first, with these headings in this order. Leave out any that would be empty.

- `## Changed`: what you changed.
- `## Deviated`: where you departed from the task, and why.
- `## Missing context`: what you needed that the task files did not give you.
- `## Next`: for unfinished work, the acceptance line to pick up next.

End the file with one line, `Touched: <path>, <path>`, listing every file you changed other than the result file, relative to the project root.

Then exit. One attempt. Do not ask questions.

## Where things live

- Living capability specs live under `openspec/specs/` as `<capability>/spec.md`. Never edit them; the watcher applies approved deltas at archive.
- In-flight changes live under `openspec/changes/<id>-<slug>/`: `proposal.md`, delta specs as `specs/<capability>/spec.md`, and one `tasks/<n>.md` per task.
- `tasks.md` and every file under `.run/` except your result file belong to the watcher and the human. Never edit them.
- Approval gate: only `osq approve`, run by a human, writes `.run/approved`. Verification gate: only the watcher's own `verify` run marks a task done.

## Planning a change

Planners follow `PLANNER.md`. When `osq plan` started you, `plan-prompt.md` in the selected change folder is your complete prompt; read it and follow it exactly.

- Write only inside that change folder.
- Run `osq lint <slug>` and fix every finding before you finish.
- Never run `osq approve`; approval belongs to a human.
<!-- OSQ:END -->
