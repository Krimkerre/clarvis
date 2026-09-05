# Agent instructions for this repo

*Read this before touching anything. It applies to any coding agent working on this
repo, in any tool — Claude Code, OpenCode, Codex, or otherwise. It is a short, tool-
agnostic version of `plan.md` §0; `plan.md` is the authority if the two ever disagree.*

## First, orient yourself

1. Read **`docs/CURRENT_STATE.md`** — a live snapshot: what's built, the architecture map,
   the complexity budget, how to verify a change. Five minutes, not an hour.
2. Skim **`plan.md`** §0 (this file's source), §1 (concept), §7 (milestone table).
3. Only read **`docs/build-log.md`** if you need to know *why* a past decision was
   made — it is history, not spec, and it is large.

The README carries a table of every document here and when you would want it. Risks
live in `docs/risks.md`, and the checks still outstanding in `docs/verification.md`.

## The one rule that matters most: Plan Mode vs Code Mode

Building Clarvis follows the same discipline Clarvis itself enforces on its own users:
**propose before you touch anything.** Two modes, no blending.

**Plan Mode (default).** Agent and user work out the roadmap together. **The only
file you may write to is `plan.md`.** No project code — not a scaffold, not a config
stub, not a "quick spike" — gets created or edited in this mode, however small.

- **Hard sign-off gate.** Do not write a line of project code until the user
  explicitly approves the plan. Silence, a topic change, or an adjacent request is
  not approval.
- **Poke holes, don't agree.** Surface missing edge cases, unstated assumptions, and
  open questions. Nodding along to an underspecified plan is a failure mode.

**Code Mode.** Entered only after sign-off. Build piece by piece against the approved
plan.

- `plan.md` becomes a live checklist — tick off (`- [x]`) each step as it lands, so
  the plan stays the single source of truth for both scope and progress.
- Scope discovered mid-build kicks back to Plan Mode — new gap analysis, new
  sign-off — rather than growing silently inside Code Mode.

## Never invent another component's behaviour

Clarvis is one of four products in the NERVIS ecosystem, and
`ECOSYSTEM_RUNBOOK.md` §1 binds every agent working on any of them:

> **No agent may invent another ecosystem component's API, schema, capability, or
> behaviour merely to complete its own milestone.** If the required contract does not
> yet exist, implement against the canonical contract where the runbook specifies one,
> use an explicitly labelled test double where that is allowed, or stop at the
> integration gate and report the missing dependency.

For this repository that means RAVIS's routes, its pool names, its error shapes and
NERVIS's Bridge protocol are read from their documents, never guessed from what would
be convenient here. **Stop** when a path, field, capability identifier or protocol
version you need is absent, and say what is missing, which milestone needs it, and who
owns it. A locally convenient shape is not evidence.

Observed runtime behaviour outranks the documents. When an integration behaves
differently from the plan, record what happened, add a regression test, correct the
contract — and never fake the expected behaviour to satisfy a checklist.

## Two different `plan.md`s — don't confuse them

`plan.md` in *this* repo is the build plan for the Clarvis extension itself. Once
installed in someone else's project, Clarvis's own Plan Mode generates a **new,
separate `plan.md`** in that project's root the first time it's used there. This
repo's `plan.md` is never opened or edited at runtime by the extension — it has no
relationship to a user project's plan.

## Before shipping a change

```bash
npm run check          # check-types + lint + the 828-test suite
npm run test:host      # 4 tests in a real extension host; needs a display
```

Clean, always. CI runs both on every push and pull request to `main`, plus
`npm run package` — so a red build is a merge blocker rather than a note. Then, for anything touching the sandbox, a gate, or a prompt:
**verify against the real mechanism**, not just the code review — a real
`sandbox-exec` invocation, a real model call. This project has shipped
confidently-wrong fixes that passed review and failed the first time they actually
ran; `docs/build-log.md` is mostly a record of exactly that pattern.

## Keep `docs/CURRENT_STATE.md` current

If your change ships a feature, changes the architecture, or moves a milestone from
"designed" to "built," update `docs/CURRENT_STATE.md` before you're done. Every number in
it should be read live (`wc -l`, `npm test`, `git log`), never propagated from memory.
