# Clarvis — current state

*Snapshot as of 16 Aug 2026, commit `06fabcc`. Written so a different agent, in a
different tool, with no memory of how this project got here, can start working on it
in five minutes instead of reading `plan.md` end to end (4,286 lines) or
`docs/build-log.md` (913 lines) first. Those two remain the actual source of truth —
this is a map of them, not a replacement. If this file and `plan.md` disagree,
`plan.md` is right and this file is stale.*

## What this is

A VS Code extension: a sarcastic butler that lives in the editor, watches builds and
errors, and — when asked — plans and builds projects as an agentic coding assistant.
Ships as a `.vsix`. Bound to one workspace folder; dies when the window closes.

## Read this first, always

**`AGENTS.md`** in the repo root. It states the working-process rule that governs how
this codebase itself gets modified (Plan Mode vs Code Mode — propose before touching
anything) and points to everything below. If you are about to write code, read it
before this file.

## Where things live

| File / directory | What it is |
|---|---|
| `plan.md` | Current spec — concept, personality rules, every feature (§4), milestones and their exit checklists (§7), success criteria (§9). The normative document. |
| `docs/risks.md` | The risk register — what could go wrong, and what is already done about it. Was `plan.md` §8. |
| `docs/future-features.md` | The v1 boundary — what is deferred past the first release and why. Pairs with `plan.md` §7 M11, which holds the release bar itself. |
| `docs/verification.md` | The checks still to be run by hand, needing a real editor, provider or OS. Was `plan.md` §10. |
| `docs/build-log.md` | Chronological history — every defect found by using the product, and why each fix looks the way it does. Not shipped in the `.vsix` (see `.vscodeignore`). Read when you need to know *why* a decision was made, not *what* the product currently does. |
| `README.md` | The user-facing pitch and feature list, and the index of every document here — the front door. |
| `media/MANUAL.md` | The in-product `/help` manual — what a user can actually ask for. Lives in `media/` because it **ships in the `.vsix` and is read at runtime** by `ChatActions.ts`; it is a product asset, not project documentation. |
| `docs/TUTOR-README.md` | Design notes for Tutor Mode (M12, not built yet). |
| `AGENTS.md` | The working rules for a coding agent in this repo. Stays at the root because that is where agents look for it. |
| `src/` | The extension itself. See the map below. |

Written documentation lives in `docs/`. Three files stay at the root on purpose:
`README.md` (the front door), `AGENTS.md` (agents look for it there), and `plan.md` —
which the extension itself reads and writes at the workspace root, so moving it would
break Clarvis planning against its own repo.

## Architecture map

| Directory | Lines | What it owns |
|---|---|---|
| `src/agent/` | ~9,400 | The agentic loop: `AgentRunner` (the tool-calling loop), the OS-level command sandbox (`tools/sandbox*.ts`), the deny-list gate (`Gate.ts`), the sensitive-file read gate (`sensitivePath.ts`), branch isolation (`AgentBranch.ts`), undo (`Checkpoint.ts`), the run ledger (`runLedger.ts`). |
| `src/chat/` | ~6,500 | The chat panel: routing (`routing.ts` — question vs job), `ChatService` (the top-level dispatcher), `RunSession` (runs a task, offers what to do with the result), local free-form answers (`localAnswer.ts`). Its decisions live in pure modules beside it — `pendingOffers.ts`, `jobDecision.ts`, `offerAnswer.ts`. |
| `src/planning/` | ~5,600 | Project planning (§4.9): the interview, gap analysis, the generated `plan.md`, milestone builds. Almost entirely pure functions — 32 files, two classes. |
| `src/personality/` | ~2,500 | The character. One shared prompt block (`character.ts`) every surface draws from — this is the fix for the one mistake this project made twice: a second, third, fourth place writing its own voice. |
| `src/model/` | ~2,400 | Multi-provider model access — Anthropic, OpenAI, OpenRouter, Ollama, LM Studio. BYO-key; no Clarvis account, ever. |
| `src/voice/` | ~2,000 | Spoken output (Fish Audio + system TTS fallback) and the voice-input design (not built — M10). |
| `src/memory/` | ~1,100 | Pattern memory (repeat-error detection) and the lingering-error notice. |
| `src/briefing/` | ~1,000 | The on-launch "where you left off" summary. |
| `src/watch/` | ~680 | Task/build watching — the walk-away feature. |
| `src/panels/` | ~360 | The webview host for the avatar. Its stylesheet is `media/chat.css`, read from disk at render time. |
| `src/logtailing/` | ~130 | Tailing of VS Code logs into the workspace. |
| `src/test/` | ~60 | Host-level smoke tests (`npm run test:host`), not the main suite. |

**33,132 lines of TypeScript across 240 files** — 25,017 source, 8,115 test. `plan.md`
§11 breaks that down and is re-counted rather than nudged.

## What's built vs designed

Milestones are numbered M0–M12 in `plan.md` §7 and tracked with per-milestone exit
checklists (261 checklist lines total). **§7 is the authority; this is a copy, and
copies drift** — believe it over this file, the README and the manual, all three of
which restate it. Current status:

- **Built and shipped: M0 through M9**, plus M9d2 (per-language conventions), M9d3
  (the agent reads its own code back after a milestone), and **M13** (a gated command
  tailing the VS Code extension-host log into the workspace).
- **Designed, not built: M9g** (a project-notes file the user can write to, read from
  `AGENTS.md`/`CLAUDE.md`), **M10** (voice input), **M11** (packaging/release
  polish), **M12** (Tutor Mode).
- Full detail, including *why* each milestone landed the way it did: `plan.md` §7.

### What landed on 15–16 Aug, outside the milestone numbering

Two external reviews and a refactor pass. Every item below is in `docs/build-log.md`
or `plan.md` in full; this is the index.

**Safety.** A sensitive-file read gate (`.env`, credentials, private keys — fires in
every mode). Network denied by default in the command sandbox, opened only for the
gate categories that cannot work without it. A durable run ledger, and "why did you do
that" answered from it. And a **macOS containment escape**: `isInside()` inferred
filesystem case-sensitivity from `process.platform`, which is wrong on case-sensitive
APFS volumes, so a case-different path outside the workspace read as inside it. It now
probes the real filesystem.

**A real bug the refactor pass turned up.** `ChatService` documented the rule — *stop
first, always* — and then consulted five pending offers ahead of the stop check. Two
of them swallowed "stop" entirely. The precedence is now one pure, tested function
(`pendingOffers.ts`).

**Verification that runs itself.** CI (`.github/workflows/ci.yml`: `npm ci`,
`npm run check`, `npm run package`, then the host suite under `xvfb`) on every push and
PR to `main`. A host-level suite (`npm run test:host`, `@vscode/test-electron`) covering
activation, command registration, and the workspace boundary against the real API.
Neither existed before 16 Aug; `npm run check` was a gate nobody was obliged to run.

**Packaging.** `.vscodeignore`'s `*.map` never matched the nested
`dist/extension.js.map` — a bare `*.map` only matches at the ignore root — so 1.29 MB
of sourcemap had been shipping in every build. Now `**/*.map`, plus `eslint.config.mjs`,
`TUTOR-README.md`, `.github/**` and `.vscode-test.mjs`. 15 files / 1.28 MB → **10 files
/ 904 KB**, every survivor traced to a runtime reference.

**Documentation.** Split and indexed: `docs/` now holds this file, the build log, the
risk register (was `plan.md` §8), the outstanding-checks list (was §10) and the tutor
guide, with the README carrying a table of all of them. `plan.md` holds the plan.

## The complexity budget, and where it stands

`eslint.config.mjs` enforces `complexity: 15`, `max-lines-per-function: 120` and
`max-depth: 4` — added after an unanswerable "too much cyclomatic complexity" report,
so the number is enforced rather than argued about. Two things worth knowing before
adding a branch anywhere:

- **Six functions sit at exactly 15**, so the next branch in any of them fails the
  build. Find them with
  `npx eslint src --rule '{"complexity":["error",14]}'`. 63 sit above 8.
- `ChatService.ask()` was one of them until 16 Aug (now 7). `ChatService` itself is
  still 1,229 lines and **has no test file of its own**. Its decisions are covered
  instead by pure modules it calls — `pendingOffers.ts` (which pending question owns
  a message), `jobDecision.ts` (whether a message becomes a job, including the mode
  gate on every edit), `workspaceSignals.ts` (whether a folder reads as new). That is
  the pattern to follow when something in there needs to be made safe to change:
  extract the decision, test it, leave the side effects in the class.

## Safety model — the part most likely to matter to a change you're making

- **Agency is architectural, not a prompt instruction.** Clarvis edits or runs
  commands only when explicitly asked. This is enforced by which tools a turn is
  given, not by asking the model nicely.
- **Workspace-bound, provably.** Every file tool resolves and refuses any path
  outside the activating workspace (`resolveInWorkspace`).
- **Commands run inside an OS-level sandbox** (`sandbox-exec` on macOS, `bwrap` on
  Linux) that denies writes outside the workspace and its known build caches.
  **Network is denied by default** as of 15 Aug, opened only for commands the gate
  already classifies as needing it (dependency installs, `git push`/`publish`).
- **A deny-list gate** stops destructive, outward-facing, privileged, or
  remote-code-executing commands for explicit approval, enforced in the tool layer
  — a model cannot talk its way past it.
- **Reads of likely-secret files** (`.env`, cloud credentials, private keys) stop for
  approval too, regardless of mode — the one deliberate exception to "reads are
  never gated."
- **Every run is undoable**: a checkpoint before it starts, its own git branch, and
  `Clarvis: Undo Last Agent Run`.
- **Every run leaves a record** (`runLedger.ts`): intent, steps with their
  reasoning, files actually changed, result. `Clarvis: Show Last Run Summary` opens
  it; chat can answer "why did you edit X" from it.

## Verifying a change

```bash
npm run check-types   # tsc --noEmit
npm test               # node's built-in test runner, no framework — 872 tests currently
npm run lint            # eslint
npm run package         # esbuild bundle + vsce package -> clarvis.vsix
npm run test:host       # @vscode/test-electron, needs a display — see below
```

**Manual release checklist** — what CI and `test:host` genuinely cannot cover, so it
doesn't quietly become nobody's job (from the 16 Aug review):
- [ ] Windows: sandbox falls back correctly (no `sandbox-exec`/`bwrap` there — see
  `sandboxProfile.ts`), and the network-confinement asks-once dialog appears.
- [ ] VSCodium, not just VS Code: the extension activates and the webview renders.
- [ ] A real Fish Audio key: voice actually plays, and the system-TTS fallback works
  when it's absent.
- [ ] A real model provider call (at least one of the five) succeeds end to end
  through the chat panel, not just against a mocked response.
- [ ] Panel reload/move: dragging the avatar panel to a different position, and
  closing/reopening the window, doesn't lose or duplicate state.

Then, to actually run it: install the `.vsix` into VS Code
(`code --install-extension clarvis.vsix --force`) and reload the window — a green
test suite has repeatedly passed over defects that only running the product caught
(see `docs/build-log.md`; it is the whole reason that file exists). **Prefer testing
a fix against the real mechanism it touches** (a real `sandbox-exec` invocation, a
real model call) over trusting the code's own claim about itself — this project has
shipped confidently-wrong fixes to code review before and caught them by running the
actual thing.

## What is still open

[`verification.md`](verification.md) is the live checklist — not this file. Headline items as of 15 Aug:
the M6 "does the character hold up over days of ordinary use" pass (blocked on
`agent`-mode runs suppressing the watch surfaces that would exercise it — see `verification.md` for
the reasoning), ~45 finer-grained M8 items unverified, and two of four planned
checklist projects (3 and 4) not yet run.

## Recommendations for working on this from a different tool/model

1. **Read `AGENTS.md`, then this file, then `plan.md` §0 and §7** (working process
   and the milestone table) before writing anything. Skip `docs/build-log.md` unless
   you need to know why a specific decision was made.
2. **This file will go stale.** Update it at the end of any session that ships a
   feature or changes the architecture map — treat it like `plan.md`'s own §11 (the
   codebase, measured), which gets re-counted rather than nudged.
3. **Don't trust a number here without checking it.** Every count in this file was
   read live from the repo when written (`wc -l`, `npm test`, `git log`). If it looks
   stale, it probably is — recount rather than propagate.
4. **The plan/code-mode discipline in `AGENTS.md` is not optional cosmetics.** It is
   the single rule this project has needed most: no project code changes while
   planning, explicit sign-off before building, gap-analysis rather than agreement
   during planning. A different model is exactly as capable of skipping it as this
   one was tempted to.
5. **Verify sandbox/security changes against the real mechanism**, not the code
   review. `sandbox-exec`/`bwrap` behave differently from what SBPL/bwrap flags read
   like on paper — this project has been burned by that twice.
