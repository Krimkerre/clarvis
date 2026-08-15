# Clarvis — current state

*Snapshot as of 15 Aug 2026, commit `2b845f5`. Written so a different agent, in a
different tool, with no memory of how this project got here, can start working on it
in five minutes instead of reading `plan.md` end to end (4,325 lines) or
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
| `plan.md` | Current spec — concept, personality rules, every feature (§4), milestones (§7), risks, success criteria, and the still-open verification checklist (§10). The normative document. |
| `docs/build-log.md` | Chronological history — every defect found by using the product, and why each fix looks the way it does. Not shipped in the `.vsix` (see `.vscodeignore`). Read when you need to know *why* a decision was made, not *what* the product currently does. |
| `README.md` | The user-facing pitch and feature list. |
| `media/MANUAL.md` | The in-product `/help` manual — what a user can actually ask for. |
| `TUTOR-README.md` | Design notes for Tutor Mode (M12, not built yet). |
| `src/` | The extension itself. See the map below. |

## Architecture map

| Directory | Lines | What it owns |
|---|---|---|
| `src/agent/` | ~9,300 | The agentic loop: `AgentRunner` (the tool-calling loop), the OS-level command sandbox (`tools/sandbox*.ts`), the deny-list gate (`Gate.ts`), the sensitive-file read gate (`sensitivePath.ts`), branch isolation (`AgentBranch.ts`), undo (`Checkpoint.ts`), the run ledger (`runLedger.ts`). |
| `src/chat/` | ~6,200 | The chat panel: routing (`routing.ts` — question vs job), `ChatService` (the top-level dispatcher), `RunSession` (runs a task, offers what to do with the result), local free-form answers (`localAnswer.ts`). |
| `src/planning/` | ~5,500 | Project planning (§4.9): the interview, gap analysis, the generated `plan.md`, milestone builds. Almost entirely pure functions — 29 files, one class. |
| `src/personality/` | ~2,500 | The character. One shared prompt block (`character.ts`) every surface draws from — this is the fix for the one mistake this project made twice: a second, third, fourth place writing its own voice. |
| `src/model/` | ~2,400 | Multi-provider model access — Anthropic, OpenAI, OpenRouter, Ollama, LM Studio. BYO-key; no Clarvis account, ever. |
| `src/voice/` | ~2,000 | Spoken output (Fish Audio + system TTS fallback) and the voice-input design (not built — M10). |
| `src/memory/` | ~1,100 | Pattern memory (repeat-error detection) and the lingering-error notice. |
| `src/briefing/` | ~1,000 | The on-launch "where you left off" summary. |
| `src/watch/` | ~680 | Task/build watching — the walk-away feature. |
|    `src/panels/` | ~430 | The webview host for the avatar. |
   `src/logtailing/` | ~60 | Tailing of VS Code logs into the workspace. |

## What's built vs designed

Milestones are numbered M0–M12 in `plan.md` §7 and tracked with per-milestone exit
checklists (261 checklist lines total). Current status:

- **Built and shipped: M0 through M9**, plus M9d2 (per-language conventions), M9d3
  (the agent reads its own code back after a milestone — see below), and the four
  fixes landed 15 Aug (sensitive-file gate, network-deny-by-default sandbox, the run
   ledger, and item A/B from an external review — see `docs/build-log.md` for all
   four).
- **M13 - Live VS Code Log Tailing.** A gated command to tail the VS Code extension host logs into the workspace.
- **Designed, not built: M9g** (a project-notes file the user can write to, read from
  `AGENTS.md`/`CLAUDE.md`), **M10** (voice input), **M11** (packaging/release
  polish), **M12** (Tutor Mode).
- Full detail, including *why* each milestone landed the way it did: `plan.md` §7.

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
npm test               # node's built-in test runner, no framework — 801 tests currently
npm run lint            # eslint
npm run package         # esbuild bundle + vsce package -> clarvis.vsix
```

Then, to actually run it: install the `.vsix` into VS Code
(`code --install-extension clarvis.vsix --force`) and reload the window — a green
test suite has repeatedly passed over defects that only running the product caught
(see `docs/build-log.md`; it is the whole reason that file exists). **Prefer testing
a fix against the real mechanism it touches** (a real `sandbox-exec` invocation, a
real model call) over trusting the code's own claim about itself — this project has
shipped confidently-wrong fixes to code review before and caught them by running the
actual thing.

## What is still open

`plan.md` §10 is the live checklist — not this file. Headline items as of 15 Aug:
the M6 "does the character hold up over days of ordinary use" pass (blocked on
`agent`-mode runs suppressing the watch surfaces that would exercise it — see §10 for
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
