# osq run notes: changes 009 to 012

Notes from planning and running changes 009 (ingress with Caddy) to 012 (first real deploy) of ts-paas with osq 0.2.1. Claude Opus planned each change; the executor was `deepseek-flash` through the `pi` harness. These notes judge osq as the tool in between, not the models.

## Outcome

| Change | Tasks | First-attempt passes | Executor cost | Found after landing |
|---|---|---|---|---|
| 009 ingress-caddy | 7 | 7 | $0.21 | Two real bugs, both caught only by the integration tier |
| 010 ingress-fixes | 2 | 2 | $0.04 | none |
| 011 reconcile | 3 | 3 | $0.15 | A `--redeploy` gap, caught only by the manual walkthrough |
| 012 first-real-deploy | 3 | 3 | $0.13 | A Podman 3.4 port-forwarder leak, caught by the e2e run |

Over all twelve changes, `osq report` shows 35 of 35 tasks done on the first attempt, with no dead tasks, no regressions, no rejections, and $1.25 in total executor cost.

Every task passed. Every problem that mattered was found after a change landed, by running against a real engine. So the executor did its part; the gaps are in what the plan and the gate could check.

## What worked

- **The planning prompt.** `plan-prompt.md` holds everything needed in one place: the brief, the landed dependencies, the living specs to read, and the repository's record. It also picks up capabilities created by earlier changes, such as `ingress` in 011. Planning never needed a question back to the human.
- **Scope, frozen tests, and `tests.modify`.** Executors stayed in scope. The one frozen test that had to change (011, task 3) changed only in the assertion the plan named. Planning had to state exactly which test and which line, and that kept the change reviewable.
- **Result files.** The `Deviated` and `Missing context` sections carried real information, such as the fake clock needing a yield before `advance` (009), a `verify` that started green (010), and a port missing a field (011). Each one became a planner lesson.
- **Queuing a fix.** Integration run, queue item, `osq plan --next`, plan, approve, watch, commit. This made 010 a small, reviewable change with specs, tests and history that say why, instead of a hand patch. It took about as long as a manual fix would have.
- **Lint limits.** At most 8 scope patterns and 7 acceptance lines forced sensible task sizes, and every task fit.

## Problems, most costly first

1. **An archived change is not a working change.** 009 landed, fully verified, with an admin client that got HTTP 403 from every real Caddy. The real check was a human step after archiving. osq could keep a change open until its human steps are confirmed, or let a proposal name an integration command that must pass before the change is archived.
2. **`verify_starts: red` is not enforced, and the report contradicts itself.** `node --test` skips a missing file when other files are listed, so a `verify` that mixes a new test with existing ones starts green. That happened for four of seven tasks in 009 and both in 010. The watcher started them anyway, with no event. `osq report` prints "Pre-spawn verify mismatches: 0 of 35 runs" and, a few lines later, "red 13 of 35 passed". A green start on a red task should at least be recorded, and the mismatch count should match.
3. **Nothing checks a brief's capability list.** The brief for 009, and again the one for 011, listed only `deployments` and `app-state`. Both also changed `cli`, which owns `src/commands/`. osq already knows the ownership globs, so it could warn when a task scope touches a capability that has no delta.
4. **Lint output is hard to act on.**
   - "Requirement text is very long (>500 characters)" appeared on every change, but it came from the living `container-runtime` spec. It even appeared on an untouched template. It should name the file and the requirement, and not be charged to the change being linted.
   - The `&&` finding does not say whether it is an error, why chaining is forbidden, or what to do instead.
5. **The approval digest is misleading in two ways.**
   - "0 scope files" for tasks that only create files reads like an empty task. Something like "3 entries (0 existing, 3 new)" would be clearer.
   - It reprints "Run `osq approve <id>` yourself" while that command is running.
6. **Instructions conflict.**
   - `AGENTS.md` says `tasks.md` belongs to the watcher and the human, "never edit", but the planner has to write it.
   - `PLANNER.md` gives two modes, "interactive" (stop after the task titles) and "handoff" (follow `plan-prompt.md` exactly), without saying which wins when a human is present during a handoff.
7. **Small things.**
   - `manifest.json` records `approvedAt` 18 ms after `createdAt`, before anyone approves.
   - Every result file ends with its `Touched:` line twice.
   - `npx osq` fails because of `devEngines`; only `pnpm exec osq` works, and the prompts do not say so.
   - Appending a queue item marks the previous last item "changed since planned": its hashed body picked up the file's trailing blank line. Brief hashing should ignore trailing whitespace.

## What the planner learned

These are in the planner's memory for the next changes:
- Name only new test files in a task's `verify`. A single missing file makes `node --test` exit 1, so the task really starts red.
- Check each output format in the acceptance lines against the port's fields.
- Look at test servers and fakes with suspicion. A fake that accepts anything cannot catch a header check like Caddy's.
- Check every brief's capability list against the ownership globs.
