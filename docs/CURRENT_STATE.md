# Clarvis — current state

*Snapshot as of 20 Aug 2026 (evening), commit `f66e69a`. Written so a different agent, in a
different tool, with no memory of how this project got here, can start working on it
in five minutes instead of reading `plan.md` end to end (4,813 lines) or
`docs/build-log.md` (913 lines) first. Those two remain the actual source of truth —
this is a map of them, not a replacement. If this file and `plan.md` disagree,
`plan.md` is right and this file is stale.*

## What this is

A VS Code extension: a sarcastic butler that lives in the editor, watches builds and
errors, and — when asked — plans and builds projects as an agentic coding assistant.
Ships as a `.vsix`. Bound to one workspace folder; dies when the window closes.

## Continuing a session in progress?

**`clarvis-firstrun/docs/NEXT.md`** is the handoff from the last working session: what is in
flight, what was decided and should not be relitigated, and — usefully — a list of claims
that turned out to be wrong, so a stale quotation of one does not get trusted. Read it
before this file if you are picking up rather than starting cold.

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
| `docs/benchmarks.md` | Measured comparison of local models against Clarvis's two roles — timings against the real deadlines, tool-call reliability, and the pre-download screen. Harness lives in `clarvis-firstrun`. |
| `docs/verification.md` | The checks still to be run by hand, needing a real editor, provider or OS. Was `plan.md` §10. |
| `docs/build-log.md` | Chronological history — every defect found by using the product, and why each fix looks the way it does. Not shipped in the `.vsix` (see `.vscodeignore`). Read when you need to know *why* a decision was made, not *what* the product currently does. |
| `README.md` | The user-facing pitch and feature list, and the index of every document here — the front door. |
| `media/MANUAL.md` | The in-product `/help` manual — what a user can actually ask for. Lives in `media/` because it **ships in the `.vsix` and is read at runtime** by `ChatActions.ts`; it is a product asset, not project documentation. |
| `docs/refactor-brief.md` | A cold-start prompt for a refactor pass — the constraints a fresh session would otherwise break, and the measured starting points, marked crude where they are crude. |
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
| `src/agent/` | ~9,616 | The agentic loop: `AgentRunner` (the tool-calling loop) and the sibling `streamNarration.ts` (the per-fragment strip that keeps a `[[state]]` tag off screen — split out `vscode`-free so it is unit-testable, after a fix that lived inside `AgentRunner.ts` shipped broken and untested), the OS-level command sandbox (`tools/sandbox*.ts`), the deny-list gate (`Gate.ts`), the sensitive-file read gate (`sensitivePath.ts`), branch isolation (`AgentBranch.ts`), undo (`Checkpoint.ts`), the run ledger (`runLedger.ts`). |
| `src/chat/` | ~6,876 | The chat panel: routing (`routing.ts` — question vs job), `ChatService` (the top-level dispatcher), `RunSession` (runs a task, offers what to do with the result), local free-form answers (`localAnswer.ts`). Its decisions live in pure modules beside it — `pendingOffers.ts`, `jobDecision.ts`, `offerAnswer.ts`. |
| `src/planning/` | ~6,832 | Project planning (§4.9): the interview, gap analysis, the generated `plan.md`, milestone builds. Almost entirely pure functions. Rejected findings now travel to the milestone planner with their reasoning (`verdictSummary.ts`'s `rejectionNote`) rather than being filtered out before it — see F5 in `docs/verification.md`. |
| `src/personality/` | ~3,324 | The character. One shared prompt block (`character.ts`) every surface draws from — this is the fix for the one mistake this project made twice: a second, third, fourth place writing its own voice. `grounded.ts` (new) rejects a rewritten line whose numbers the facts it was given cannot account for — the guard behind F19, catching a small model re-filing a number under a different noun rather than inventing one outright. `asides.ts` (new) is the written-line bank for things the user clicks rather than events the product notices, deliberately separate from §5's dev-event quip table. |
| `src/model/` | ~3,743 | Multi-provider model access — Anthropic, OpenAI, OpenRouter, and three local rows (LM Studio, Ollama, and a Custom OpenAI-compatible one that asks for its address, `needsUrl`, rather than shipping a guessed default). BYO-key; no Clarvis account, ever. |
| `src/voice/` | ~2,078 | Spoken output (Fish Audio + system TTS fallback) and the voice-input design (not built — M10). |
| `src/memory/` | ~1,136 | Pattern memory (repeat-error detection) and the lingering-error notice. |
| `src/briefing/` | ~1,052 | The on-launch "where you left off" summary. |
| `src/watch/` | ~679 | Task/build watching — the walk-away feature. |
| `src/panels/` | ~360 | The webview host for the avatar. Its stylesheet is `media/chat.css`, read from disk at render time. |
| `src/bridge/` | ~3,900 | The NERVIS Bridge (M14): identity, the MEP surface, a bounded event stream, the HTTP server, registration and the lease. Seven of its eight modules import nothing from `vscode`, so the fast suite starts real servers on real ports — `wire.ts` is the only one that knows the host, and it is deliberately about eighty lines. `activity.ts`'s `snapshot()` is flat primitives with nothing to call: that is the structural half of `CLARVIS.md` §6.7, since the Bridge is handed a copy of the state rather than the controllers that hold it, and `ExtensionContext` (whose `.secrets` is the credential store) is a field on five of those controllers. |
| `src/logtailing/` | ~128 | Tailing of VS Code logs into the workspace. |
| `src/test/` | ~57 | Host-level smoke tests (`npm run test:host`), not the main suite. |

**41,940 lines of TypeScript across 281 files** — 29,580 source, 12,360 test. `plan.md`
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
  `AGENTS.md`/`CLAUDE.md`), **M10** (voice input), **M12** (Tutor Mode).
- **Three things shipped on 20 Aug (late) that the map above predates.** Reasoning models
  are handled at the provider — their thinking is stripped from the reply, and a stream
  that carries reasoning and no visible text is named as such instead of being reported as
  slow (`src/model/reasoning.ts`, M8i part 1). Local models Clarvis loaded are released
  when nothing points at them any more (`lmStudioTune.ts`). And a spoken reply past ~20
  seconds is trimmed to its opening sentence and his closing line, behind
  `clarvis.voice.trimLongReplies` (`src/chat/replyDelivery.ts`, F20).
- **M11 is the active gate, not a future milestone.** 19–20 Aug reframed it: the goal
  became *a stable first release* rather than a more complete one, and M11's exit
  checklist gained a **v1 release bar** — now **23 items, 22 done** as of 20 Aug
  (late evening); it grew as walking the product found more, which is the point. Each one
  a defect found by walking the verification runbook on a real fixture rather than by
  inspection. See the next section and `plan.md` §7's M11 for the live list.
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

### What landed on 19–20 Aug, outside the milestone numbering

The runbook's first scripted session was finally walked, twice, on a real fixture
project — and every defect below was found by using the product, not by reading it.
Full detail: `clarvis-firstrun/docs/FINDINGS.md` (20 findings, F1–F20) and its session index
at the end of that file. This is the shipped subset.

**The interview stopped nagging.** `challengeAnswer()` had been generalised on 13 Aug
from a rule written for the language question alone to all eight topics; walking it
found five pushbacks in seven ordinary answers, one re-asking a question one second
after it was answered. Narrowed back (M9h part 4) to firing only on an answer that is
genuinely unusable. As a direct consequence, `NO-PLAN-NEEDED` — which had never fired
on its designed input — fired correctly on two independent re-walks, with
`analysisPrompt.ts` untouched: the analysis was never broken, the interview was
manufacturing the contradictions it tripped over.

**Reaching a branch for the first time kept exposing what nobody had read downstream
of it.** The no-plan path had never fired before 19 Aug, so nothing behind it had ever
been exercised: the build offer was gated on the plan being *approved* (false on this
path by definition) and said nothing; the handoff task pointed at a `plan.md` that on
this path is deliberately never written, in three places; the task carried six of the
eight interview answers because the other two normally lived in the plan document that
does not exist here. All three fixed (F8, F9, F12). The same shape recurred with F15
(below): a fix inside `AgentRunner.ts`, which imports `vscode` at module scope and is
therefore untestable by `node --test`, was verified by reading it, shipped incomplete,
and was only caught by re-verifying live the same evening.

**Two more interview defects, both about the interview discarding what the user
said.** A wandering follow-up's synthesis could report the *original* topic as
unsettled, overwriting a settled answer (F2) — traced to a licensing clause in the
synthesis prompt, fixed in both the prompt and a code-level guard
(`discardsOriginalAnswer`) because "a prompt is a hypothesis until someone reads the
output" (§7). And a rejected finding's reasoning was filtered out before milestone
generation ever saw it, so a plan could do the exact thing the user had just declined
(F5) — `docs/risks.md`'s promise that rejections are "never silently adopted" was true
on paper and false in the generated plan until this landed.

**A reload could destroy real work.** The saved interview snapshot was cleared the
moment the *questions* finished, before the analysis, the findings the user ruled on,
or the drafted plan existed anywhere else — reloading at the approve gate silently
discarded all of it (F7). Fixed: kept until planning reaches an actual outcome. A
sibling defect, found and **not yet fixed**: the offer to fold an agent's work back
into the user's branch also lives only in memory, so a reload after a run leaves the
user stranded on the temp branch with no route back offered (F10, open).

**A delegated choice went unnamed.** Answering "you pick" for the project language
resolved to a real choice that only ever reached the log, never the chat — a remark
alluded to it without naming it (F1). And the interview could ask which language to use
one line after the user had already stated it in prose (F11) — both fixed, both reusing
the same mechanism: state the choice out loud rather than assume it silently, because
silent assumption is what turned a terminal script into a browser page the first time
this shipped.

**A local-model thread, started by the user running LM Studio and later doing a
deliberate A/B against Anthropic.** Three provider-picker rows now exist — LM Studio,
Ollama, Custom (OpenAI-compatible, asks for its address rather than guessing one) — in
place of a two-row list that described one as "same as Ollama, different port." The
manual gained a section on running a model locally, including a by-memory model-size
table. And the A/B surfaced findings nothing else would have: the character prompt
reproduces its own documented past failure almost verbatim on a small model (F18, and
must **not** be fixed by rewriting the character — §2.1 already warns against tuning a
prompt to a weak model's output); a small model re-files a given number under a
different noun rather than inventing one from nothing, so grounding is fixed by
comparing `(value, noun)` pairs rather than checking digits (F19, code-level fix
shipped, `grounded.ts`, covers rewritten lines only — the busier `AgentRunner` reply
path is still unguarded); and reply length is worst on the *best* model — 73–77s
against a 20s ceiling on Anthropic, the default provider (F20, open).

**`M8j` (model-family tiering for defaults) now has four callers wanting the same
mechanism** — F14's longer deadlines for slow local models, F16's smaller step budgets for
questions that don't need a tool loop, F18's knowing which models can carry the voice at
all, and possibly F21's opposite nudge (a weak model that gives up early may need *more*
steps) — and is still unbuilt. `M8h` (the spend-guard decision) is **resolved**
— chat and agent get no daily cap, by design, spend is the provider's console. `M8i`
part 1 (strip reasoning blocks from local models) is still open, awaiting build.

### What landed on 21 Aug: a §0 audit and refactor pass

Fifteen commits, `npm run check` green on both sides of every one. Full reasoning in
`docs/build-log.md`; this is what a later session needs to know.

**`Interview.ts` is unit-testable now, and has tests.** It had none, and the reason was
one import: `researchWorkspace` needs `vscode`, so `node --test` could not load the file
— all 879 lines of it, including the paths behind six of the twenty runbook findings.
`PlanningFlow` reads the workspace and hands the signals in. Ten tests where there were
zero. `runInterview`'s three optional trailing parameters became one `InterviewSession`.

**One `collect()` where there were thirteen.** Every phrasing call hand-wrote the same
capped, self-abort-swallowing stream read. `src/model/collect.ts` is the one copy; each
caller passes its own limit, which is the part that had drifted. `Interview.ts` 879 → 810
lines as a result.

**Both providers' `stream()` calls their own `post()`.** The comment saying they "cannot
drift apart" was false in both files and they had drifted — Anthropic to two undocumented
`max_tokens` budgets, the OpenAI adapter to two message mappings and two frame parsers.
The **read loops are deliberately untouched**: their `[DONE]` handling differs, and
unifying it changes behaviour in an edge case.

**Flag arguments: 20 → 9.** Split where the body was two functions in a trenchcoat
(`AgentRunner.completed`, `planFacingLines`, the milestone-settled pair). Named where
splitting would only push the same ternary into a caller that was itself handed the
boolean (`OpeningKind`, `PlanBacking`, the sandbox's `Confinement`). Deleted where the
flag was hiding that nobody wanted it — `setMuted(boolean)` had two callers and both
passed `!isMuted`, so it is `toggleMute()`.

**Three findings recorded and deliberately not acted on.** Each would change behaviour:

- **The Git extension is reached from eight places**, five with their own `GitExports`.
  Three of them check `isActive` and give up, which is the exact defect
  `BranchFlowWatcher`'s copy documents having already cost this project. They all run
  after activation in practice, so it is latent — but unifying means three synchronous
  functions become async.
- **`isEscalation` has no production caller, and the §4.6 rule it implements may not be
  shipped.** "Replying to an unsolicited remark is what makes it a request" lives only
  in that function and its four tests. The product runs `isDoItNow` gated on
  `hasLastAnswered`, and `lastAnswered` is set only when Clarvis answered a question the
  user asked — never by an unsolicited surface. Worth checking live before deciding
  whether it is a gap or a rule that was superseded.
- **`ChatService` still holds five temporary offer fields**, armed and disarmed at
  separate sites and hand-reassembled into an armed-set. The *precedence* was extracted
  into the tested `pendingOffers.ts` after the "stop was swallowed" bug; the *state* it
  reads was not. Adding an offer still means a field, an arming site, two disarming
  sites, an entry in the map and an entry in `OFFER_ORDER`.

Also measured and left alone by decision: §0 caps lines "around 100 characters" and 553
source lines exceed it (301 code, 252 prose inside template literals). Nothing enforces
it, reflowing them is a diff across nearly every file, and `eslint.config.mjs` explicitly
refuses style rules that produce a wall of warnings. The rule and the practice disagree;
that is recorded rather than resolved.

## The complexity budget, and where it stands

`eslint.config.mjs` enforces `complexity: 15`, `max-lines-per-function: 120` and
`max-depth: 4` — added after an unanswerable "too much cyclomatic complexity" report,
so the number is enforced rather than argued about. Two things worth knowing before
adding a branch anywhere:

- **Six functions sit at exactly 15** as of 21 Aug (five on 20 Aug, six on 16 Aug), so
  the next branch in any of them fails the build. Find them with
  `npx eslint src --rule '{"complexity":["error",14]}'`. 64 sit above 8. The six:
  `AgentRunner.runGated`, `gitPlain.explainState`, `RunSession.close`,
  `OpenAiCompatibleProvider.streamWithTools`, `Interview.continueInterview`,
  `PlanWriter.renderPlan`.
- **The ceiling is a live budget, not a backdrop.** The §0 refactor pass spent a point
  without meaning to — splitting `AgentRunner.completed`'s flag argument put a ternary
  in `loop` and took it from 14 to 15 — and only noticed by measuring against `main`
  rather than by reading the diff. Paid back in the same pass. Measure before and after
  any change that adds a branch; the build passing says nothing about headroom.
- `ChatService.ask()` was one of them until 16 Aug (now 7). `ChatService` itself is
  still 1,229 lines and **has no test file of its own**. Its decisions are covered
  instead by pure modules it calls — `pendingOffers.ts` (which pending question owns
  a message), `jobDecision.ts` (whether a message becomes a job, including the mode
  gate on every edit), `workspaceSignals.ts` (whether a folder reads as new). That is
  the pattern to follow when something in there needs to be made safe to change:
  extract the decision, test it, leave the side effects in the class.
- **This ceiling was hit three separate times on 19–20 Aug** — `PlanningFlow.runPlanning`,
  `handoff.ts`'s `handoffTask`, and `AgentRunner`'s `loop` all needed a decision pulled
  out into its own pure function before the fix that was actually wanted would pass
  lint. In each case the extraction turned out to be the right structure anyway (and in
  `AgentRunner`'s case, the only way to make the logic reachable from a unit test at
  all — see *Recommendations* below). Three hits in one session on a five-function
  ceiling is worth treating as a signal that these particular functions keep being the
  ones that need to change, not as friction to route around.

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
npm test               # node's built-in test runner, no framework — 1182 tests currently
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

**M14, the NERVIS Bridge, is built and unproven live (29 Aug).** Every code exit item in
`plan.md` §7 M14 is ticked; the two that are not are the ones a test cannot close — two
real editor windows against a real NERVIS, and "disabling it restores exact standalone
behaviour". Those are what Stage 8 is graded on, and neither has been run.

The part worth knowing before touching it: `src/bridge/activity.ts` is the only source of
"what is Clarvis doing", there is exactly one per extension host (it hangs off `RunState`,
alongside the `running` flag the quips and the watcher already read), and `Busy` plus
`whileAwaiting` are the only things that write to it. `clarvis.bridge.enabled` is false by
default, and off means nothing is bound rather than a socket that refuses.

Two live bugs were found and fixed getting there, both of which had been shipping: every
`Busy.start` call site passed `'reply'`, so `isRunning` was dead code and the two
suppressions reading it were silently off; and `clarvis.runTask` ran an agent entirely
outside `Busy`, so quips talked over palette runs and the watcher announced builds those
runs had caused. The reason neither was caught is now the more useful finding — `Busy`'s
`ButlerViewProvider` import is **type-only**, so the compiled module requires nothing and
`node --test` could always have reached it. "It takes a `vscode` type, so it must need the
host suite" was wrong, and is probably wrong elsewhere in this codebase too. Check the
compiled `require`s before assuming a file is untestable.

Three live trackers, not this file — this section only says which one to open.

**The v1 release bar** — `plan.md` §7, M11 — is the one that gates shipping. **23 items,
22 done** as of 20 Aug (late evening); **one open: runbook sessions A–C**. M8i part 1
closed with both of its failure modes observed on the wire rather than one of them
predicted.

**F20 is closed, on a listening pass rather than a measurement.** Six versions of
`ANSWER_SHAPE` failed to shorten spoken replies — the effect proved smaller than the
measurement noise, and tightening cost the character — so the ceiling moved into
`spokenPart` (`src/chat/replyDelivery.ts`): past about twenty seconds the voice gets the
opening sentence and his closing line, the panel keeps every word, and
`clarvis.voice.trimLongReplies` turns it off. Check it, not this paragraph, for the current
count — it has changed six times in two days.

**The verification runbook** — `clarvis-firstrun/docs/RUNBOOK.md`, a *separate repository*
from this one — was **rescoped on 20 Aug from seven ~90-minute sessions to four of ~50**
(A safety, B loop seams, C local models, D fixtures), because the seven were not being
walked and a runbook nobody finishes verifies nothing. Session 1's content is largely
covered and walked; **A–C have not run.** The cut is recorded with its reasoning in the
runbook's own *Cut, and why* table, including one dogfood track dropped entirely. Its findings
land in `clarvis-firstrun/docs/FINDINGS.md`, cross-checked against this repo's release bar
and `docs/future-features.md` by `tools/check-findings.mjs` — a finding that exists in only
one place is a bug in the bookkeeping, and that script fails on it.

**The M6 dogfood pass** — does the character hold up over days of ordinary use — is
still the one nothing above closes. It needs the same lines heard repeatedly across
real days of work, which a scripted session cannot produce by design; `RUNBOOK.md`'s
remaining track (`nanocode`, scoped to chapters 1–3) exists for exactly this and has
barely started. The Rust OS track was cut on 20 Aug: it existed almost entirely to fire
`buildSlow` and `bigDiff`, and weeks of evenings for two thresholds is a bad trade — that
neither fires on real work is itself recorded as the finding, in `VOICE-LOG.md`
long enough yet. [`verification.md`](verification.md) carries the finer-grained M8
items (~45, last counted 15 Aug — recount rather than trust that number).

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
6. **A fix inside a file that imports `vscode` at module scope is untestable by
   `node --test`, and "verified" by reading it is not verified.** 20 Aug: a fix to
   `AgentRunner.ts` shipped, was reviewed by reading the diff, and did not work —
   caught only by re-running the product live the same evening. The actual fix moved
   the logic into a sibling `vscode`-free module specifically so a test could reach it.
   If a change lives somewhere `node --test` cannot import, that is a reason to extract
   the pure part before trusting the fix, not after.
