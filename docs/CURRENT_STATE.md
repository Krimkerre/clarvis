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
| `AGENTS.md` | The working rules for a coding agent in this repo. Stays at the root because that is where agents look for it. |
| `src/` | The extension itself. See the map below. |

Written documentation lives in `docs/`. Three files stay at the root on purpose:
`README.md` (the front door), `AGENTS.md` (agents look for it there), and `plan.md` —
which the extension itself reads and writes at the workspace root, so moving it would
break Clarvis planning against its own repo.

## Architecture map

| Directory | Lines | What it owns |
|---|---|---|
| `src/agent/` | ~9,616 | The agentic loop: `AgentRunner` (the tool-calling loop) and the sibling `streamNarration.ts` (the per-fragment strip that keeps a `[[state]]` tag off screen — split out `vscode`-free so it is unit-testable, after a fix that lived inside `AgentRunner.ts` shipped broken and untested), the OS-level command sandbox (`tools/sandbox*.ts`), the deny-list gate (`Gate.ts`), the sensitive-file read gate (`sensitivePath.ts`), branch isolation (`AgentBranch.ts`), undo (`Checkpoint.ts`), the run ledger (`runLedger.ts`), and earlier work left on a branch (`leftBranches.ts`, shared by both engines, with the rule for what a branch switch may carry; `leftRuns.ts`, Clarvis's own engine's runs). Since 15 Sep, the owner's skills for a run of the own engine: `tools/skillTools.ts` reads the list from RAVIS at a run's start, holds `readSkill` and says when the list couldn't be read; the section's words are `agentPrompt.ts`'s. |
| `src/chat/` | ~6,876 | The chat panel: routing (`routing.ts` — question vs job), `ChatService` (the top-level dispatcher), `RunSession` (runs a task, offers what to do with the result), local free-form answers (`localAnswer.ts`). Its decisions live in pure modules beside it — `pendingOffers.ts`, `jobDecision.ts`, `offerAnswer.ts`, and `leftWork.ts`, the build-on-or-start-fresh question both engines ask, with each engine's words beside it. Since 15 Sep, skills as slash commands: `chatCommands.ts` holds every built-in's one-line description and the first-word parse, `skillCommands.ts` decides what `/x …` asks for and writes `/help` and the pop-up's rows, and `slashSkills.ts` reads RAVIS for the pop-up. |
| `src/planning/` | ~6,832 | Project planning (§4.9): the interview, gap analysis, the generated `plan.md`, milestone builds. Almost entirely pure functions. Rejected findings now travel to the milestone planner with their reasoning (`verdictSummary.ts`'s `rejectionNote`) rather than being filtered out before it — see F5 in `docs/verification.md`. |
| `src/personality/` | ~3,324 | The character. One shared prompt block (`character.ts`) every surface draws from — this is the fix for the one mistake this project made twice: a second, third, fourth place writing its own voice. `grounded.ts` (new) rejects a rewritten line whose numbers the facts it was given cannot account for — the guard behind F19, catching a small model re-filing a number under a different noun rather than inventing one outright. `asides.ts` (new) is the written-line bank for things the user clicks rather than events the product notices, deliberately separate from §5's dev-event quip table. |
| `src/model/` | ~3,743 | Multi-provider model access — Anthropic, OpenAI, OpenRouter, and three local rows (LM Studio, Ollama, and a Custom OpenAI-compatible one that asks for its address, `needsUrl`, rather than shipping a guessed default). BYO-key; no Clarvis account, ever. |
| `src/voice/` | ~2,078 | Spoken output (Fish Audio + system TTS fallback) and the voice-input design (not built — M10). |
| `src/memory/` | ~1,136 | Pattern memory (repeat-error detection) and the lingering-error notice. |
| `src/briefing/` | ~1,052 | The on-launch "where you left off" summary. |
| `src/watch/` | ~679 | Task/build watching — the walk-away feature. |
| `src/panels/` | ~389 | The webview host for the avatar. Its stylesheet is `media/chat.css`, and its scripts `media/bowtieMenu.js` (the bowtie's fold-out, since M15 C2b+) and `media/chat.js`, all read from disk at render time. Above the prompt row, a run's passing status (`run-status`, since C2b+ phase 2: "Reconnecting Codex…"). Since 15 Sep, the slash pop-up (`clarvis-slash`, a listbox `chat.js` fills from the host's `slash-list` rows) opens over the transcript while the box's first word starts with `/`. |
| `src/bridge/` | ~3,900 | The NERVIS Bridge (M14): identity, the MEP surface, a bounded event stream, the HTTP server, registration and the lease. Seven of its eight modules import nothing from `vscode`, so the fast suite starts real servers on real ports — `wire.ts` is the only one that knows the host, and it is deliberately about eighty lines. `activity.ts`'s `snapshot()` is flat primitives with nothing to call: that is the structural half of `CLARVIS.md` §6.7, since the Bridge is handed a copy of the state rather than the controllers that hold it, and `ExtensionContext` (whose `.secrets` is the credential store) is a field on five of those controllers. |
| `src/logtailing/` | ~128 | Tailing of VS Code logs into the workspace. |
| `src/engine/` | ~9,726 | The Codex engine (M15 C1, C2a and C3, 13 Sep; C2b and C2b+, 14 Sep). `codex/approvals.ts` asks Codex's requests in the chat — one at a time, with only the decisions RAVIS allows, checked again right before an answer is sent — gives Unattended's narrow answers while the panel is there, and asks a group of blocked sites as one card; `codex/siteScan.ts` finds the sites a task will likely need, which `runCore.ts` asks about before it starts, and `codex/siteAsks.ts` holds the words for asking about them and for carrying the task on. `checkpoint/` is the task's record in the git folder (`clarvis-task-checkpoint.json`, 0600, under 64 KB, written only while the lock is held), the brief and catch-up text built from it, `gitFacts.ts`, and beside it the record of runs Clarvis's own engine left on their branches (`leftWorkFile.ts`, `clarvis-left-work.json`). `transfer/` switches an unfinished task between the engines in either direction (`engineSwitch.ts`, with an adapter per engine). `lock/takeover.ts` takes a project over from a window the lock rule allows, after the owner's yes. `relay/` talks to RAVIS's agent-session relay: idempotent HTTP, the event stream that resumes from its cursor, typed failures (an exhausted allowance, throttling, signed out, an untested version and RAVIS not answering stay apart), the 0600 session-token file, the desktop credential file, panel presence, and whether Codex may start (`codexReadiness.ts`). `lock/` is the one-writer rule: RAVIS's project-lock API with the fence, the checkout lock file, the lock rule shared with RAVIS through `lock-rule-cases.json`, and `projectLock.ts`, which every writing run of Clarvis's own engine now takes. `codex/` follows a Codex task: `runCore.ts` holds Stop, steering, questions, the settle, presence and reattaching, tested against `FakeRavisRelay`, with `RemoteCodexRunner.ts` and `codexGit.ts` as its glue. `engineChoice.ts` decides which engine runs a task; `engineHost.ts` reads the settings it decides from. vscode-free except `engineHost.ts`, `RemoteCodexRunner.ts` and `codexGit.ts`; complexity limit 8. |
| `src/test/` | ~656 | Host-level smoke tests (`npm run test:host`), not the main suite — eight specs, recounted 14 Sep after Codex's git setup (this said seven after C2b+, and ~57, then ~378, then ~452 before that); `codexMenu.spec.ts` runs the bowtie's fold-out and Codex's undo copies in the real host, and `codexGitSetup.spec.ts` checks the Git extension sees a repository **Set up git here** made. Beside them, `fakes/` (~2,780) holds `FakeRavisRelay`, the labelled test double of RAVIS's relay, which checks every answer it gives against the contract fixtures, and since C2a its session state machine (`fakeSessions.ts`), which takes a Codex task through turns, answers, steers, stops and settles; since C3 an opt-in project-lock machine (`fakeLocks.ts`) with transfer and takeover; since C2b Codex's real requests from calibration (`calibrationRequests.ts`), held to RAVIS's committed transcripts; since C2b+ the allowed sites (`fakeSites.ts`) and R5 in the session machine — site asks a group per turn, the reopen and a turn waiting for it, a create's model and effort — each held to what RAVIS `bc1a103` does; since 15 Sep the skills for the models that aren't Codex (`fakeSkills.ts`), the list and the read of a skill's files with every refusal, held to RAVIS 0.27.0's `skills.json`. |

**72,879 lines of TypeScript across 442 files** (recounted 14 Sep, after M15 C2b+'s phase 2) — 44,994 source,
27,885 test, counting `src/test/fakes/` and the host specs as test. `plan.md` §11 breaks an older count down and is
re-counted rather than nudged.

## What's built vs designed

Milestones are numbered M0–M15 in `plan.md` §7 — there is no M12 — and tracked with
per-milestone exit checklists (257 checklist lines, recounted 12 Sep; this said M0–M12 and
261 until then). M14, the NERVIS Bridge, was signed off on 29 Aug and is built, which the
list below predates. **M15, Codex tasks through RAVIS, was signed off on 13 Sep; C1, C2a and C3
are built, and C2b and C2b+ since 14 Sep** — the relay and lock clients, the Codex runner, the engine choice, the project
lock, the task checkpoint and switching between the engines, since C2b Codex's approvals and the pre-task site scan, since C2b+ the sites asked about before and during a task and each task's model and effort, and, also since 14 Sep, the offer to set git up when a Codex task needs it, in `src/engine/`, and `FakeRavisRelay` with its session state machine in `src/test/fakes/`,
all tested against RAVIS's contract fixtures (copied into `src/test/fixtures/` and checked by
`src/test/codexContractFixtures.test.ts`). None of it has met a real Codex task: RAVIS's relay is built, but the owner's live
test hasn't run. C2b was built from calibration's transcripts (run `cal_5a1d6ecc33b4`). **§7 is the authority; this is a copy, and
copies drift** — believe it over this file, the README and the manual, all three of
which restate it. Current status:

- **Built and shipped: M0 through M9**, plus M9d2 (per-language conventions), M9d3
  (the agent reads its own code back after a milestone), and **M13** (a gated command
  tailing the VS Code extension-host log into the workspace).
- **Designed, not built: M9g** (a project-notes file the user can write to, read from
  `AGENTS.md`/`CLAUDE.md`), **M10** (voice input).
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
a design note since removed, `.github/**` and `.vscode-test.mjs`. 15 files / 1.28 MB → **10 files
/ 904 KB**, every survivor traced to a runtime reference.

**Documentation.** Split and indexed: `docs/` now holds this file, the build log, the
risk register (was `plan.md` §8) and the outstanding-checks list (was §10), with the
README carrying a table of all of them. `plan.md` holds the plan.

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

### What landed on 13 Sep: M9i — feedback that lands, a Stop that stops, failures that say so

An outside review of the planning path, reproduced against the compiled code before anything
changed. `plan.md`'s M9i section has the findings and the nine signed-off decisions; this is
what a later session needs to know.

**The flow after the interview is `planReview.ts`, and it has tests.** It lived in
`PlanningFlow.ts`, which imports `vscode`, so the analysis → findings → milestones → draft →
approval → build offer stretch had none — and every defect M9i fixed was in it.
`PlanningFlow.ts` keeps where a sitting starts, the workspace read and the plan.md write;
`planReview.test.ts` drives the rest with a scripted person, a scripted model and a draft that
can be edited while a question waits.

**One draft revision, and it is the one on screen.** `PlanningIO.readDocument()` reads the
draft back before every decision, and Approve writes exactly that. Typed feedback — Keep
Refining, or anything said at the gate that is not a button — goes to `planRevision.ts`: the
model returns only the sections it changes, and code splices them into the draft as it
currently reads, refusing the fixed sections (§0, Branch flow), unknown headings, cut-off
replies and a result with nothing left to build. With no model the feedback goes under Notes.
A draft edited while the model works keeps the edit and drops the revision, and says so.

**The build is offered from the written plan.md.** Milestone one's task is
`nextMilestoneTask`, like every later milestone's; `handoffTask` is the no-plan brief only.
There is no offer without a milestone that has steps and a check (`buildBlocker`), and only
the words Start Building start one.

**Stop pauses, and cancelling never decides.** `PlanningPaused` is thrown out of any question
and caught once, in `runPlanning`, which keeps the snapshot — and the snapshot now carries the
draft (`InterviewSnapshot.draft`), so carrying on returns to the same revision without running
the review again. In chat, `stopFromChat` → `stopReply` answers `paused` for the whole sitting,
not only while a question waits, and `PlanningChatIO` neither says nor shows anything a model
finishes after the stop. A model call already running is not aborted: it runs out its own
deadline and is ignored.

**A review that did not finish is told apart from a clean one.** `readAnalysis` needs
findings, `NO-PLAN-NEEDED` or the new `NO-FINDINGS`; `milestonesFrom` needs a step with a check
(a refusal used to parse as a step). Either failing asks Try Again or Go On Without It, and the
draft names what is missing.

**A number is an option only on its own.** `optionIndex`: `1` picks; `1 but …` and `1.5` are
free text.

**Not verified here, and needed before M9i is closed:** the revision and `NO-FINDINGS` prompts
against real models — a frontier one and the MLX tiers M9h already requires — and, in VS Code
and code-server, reading back an edited untitled draft, Stop at each question and during a
model call, a reload at the approve gate, and milestone one ticking from edited steps.
`ChatService` and `DraftDocument` import `vscode`, so their part of this was read, not run.

### What landed on 13 Sep: M15 C2a — the Codex runner, the engine choice and the project lock

`plan.md`'s M15 has the checks, ticked where they pass and noted where they don't; this is what a
later session needs to know.

**Which engine runs a task is decided in one place.** `engineChoice.ts` picks Codex only for exactly
`ravis/clarvis-codex`, set in the owner's own settings (a repository's `.vscode/settings.json` choosing it is
refused), at an address on this Mac, in a trusted folder; anything else naming Codex is refused with
its reason. `codingRunFactory.ts` gives the three places that build runners their decision: the chat's
run builds either engine, the palette never builds Codex (its questions need the panel), and the
answer path refuses Codex as a chat model before any request. The model listing now sends
`X-Clarvis-Engines: codex` to addresses on this Mac, so the coding model picker can offer
`ravis/clarvis-codex`; the chat picker never does. The id was `ravis/codex` until 0.16.1, when the owner
renamed it to match the Clarvis pools (13 September 2026); the old id is no longer recognised.

**A Codex task is followed by `runCore.ts`.** It asks RAVIS whether Codex may run before a branch
exists, creates the session with the contract's key, keeps the token in the token file, and reads the
event stream without ever waiting on a person. Stop lets go of every question in the same tick, before
any request, then interrupts; an answer that comes back after Stop, after RAVIS says the task is
stopping, or after another window answered is never sent. Typed text is steered into the running turn
or kept and delivered later, and a run that ends with text it never took in says so. Codex's messages
become text events, so `STEP:` lines move the progress bar and tick the plan as they always did; each
changed file is recorded once, however often RAVIS sends it, and nothing Codex did is done again. Work
is committed only by the window holding RAVIS's settle claim, and never on a lock RAVIS gave away. On
window load, `RunSession.reattachCodexTasks` picks up the workspace's live task from the cursor this
host stored, or from a snapshot. Until C2b, Codex's requests were declined where RAVIS allows it, and
said so; C2b replaced that on 14 Sep (below).

**Behaviour change for Clarvis's own engine: its writing runs take the project lock.** The checkout
lock file first (`<git_dir>/clarvis-engine.lock`, or `<root>/.clarvis/engine.lock` in a folder without
git, which leaves a `.clarvis` folder behind), then RAVIS's lock when RAVIS is configured and
answering, heartbeaten every 15 s. A second editor — or a palette run beside a chat run in the same
window — is refused with who holds the project. The fence stops a run whose lease RAVIS revoked, or
whose lock file now names another window: it writes nothing more, commits nothing, tidies nothing.
RAVIS not answering is never loss, and a `422` from RAVIS's lock routes (a folder outside its allowed
roots) leaves the run on the file alone. Read-only answers take no lock, and neither does Restricted
Mode.

**Checked by breaking it.** Each guard above was broken in the compiled code and its test failed, 27 of
27, and C1's 38 still fail when broken after C2a's changes to its modules. Two of the 27 first came
back uncaught — a test whose asker never answered couldn't see a question asked twice, and a test that
waited on a run without a time limit hung instead of failing — and both tests were fixed.

**Not verified here:** anything inside VS Code — `RunSession`, `AgentRunner`, `ChatService`, the palette
in `extension.ts`, `Replier` and the panel's 10-second ping import `vscode` and were read, not run — and
anything against a real RAVIS, whose relay (R3) isn't built. `npm run test:host` wasn't run (its
`stable` lookup is a network call); `src/test/engineChoice.spec.ts` is written for it.

**Finished in a second pass the same day.** A window that finds a closed window's lock file stops the
command that window recorded as running — its whole process group and every descendant, each checked by
pid and start time in the C locale before any signal, SIGTERM then SIGKILL, then confirmed gone — before it
takes the file (`groupKill.ts`, `processTable.ts`); a command that won't stop keeps the file and names
itself. A Codex task RAVIS paused because another editor held the checkout is saved from here once that
editor is gone: its command stopped, the lock file taken and registered with RAVIS as an adoption, then the
claim, the commit and the settle (final check F-A9). And **Carry on** after RAVIS's step cap starts a
`carry_on` turn on the same session instead of a new task.

**C3 — the checkpoint and switching, 13 Sep.** Every writing run keeps a record of its task in the git
folder, `clarvis-task-checkpoint.json`: what was asked and ruled out, the plan and where it got to, the
branch with its base and saved commit, changed files, checks passed or failed, what the owner typed and
whether an engine took it in, open questions, operations that may or may not have happened, the Codex
thread, and whether a switch is under way. It is written only while the lock is held, never read for
another folder, and scrubbed of secrets. **Clarvis: Switch Coding Engine** moves an unfinished task
between Codex and Clarvis's own engine, either way, in one order: the destination is asked if it can take
the task and the owner confirms the cost; the lock is reserved for the destination (RAVIS's `transfer`),
then the work stops; every process is confirmed gone, and anything left over is put to the owner, whose
cancel keeps the locks; the work is committed on the task's branch; the checkpoint is saved; Codex settles
`next: "transfer"` and stays idle, never archived; the destination takes the lock with the token and
continues on the same branch at the saved commit, refusing if the branch moved away; only then does the
source let go. A Codex session whose Codex home matches is resumed with a catch-up saying what changed;
otherwise it starts from a brief. Uncertain operations are only ever listed as things to check, never
repeated. Text typed during a switch goes into `latestFeedback`. A window may take a project over from a
window the lock rule allows — a stale heartbeat alone never counts, and a woken machine gets 90 seconds —
after the owner's yes: RAVIS's lock must be this folder's, the old window's command is stopped with its
group first, and the taken-over window's fence stops it writing. Not built: a per-task engine override (a
later run uses the settings' engine), the Wait reminder, and offering a switch after a stopped or failed
task. `ChatService` gained only a `switchEngine` delegate; `RunSession` hooks the switch, the takeover
offer and the end-of-run checkpoint. Each of C3's 18 guards was broken in the compiled code and its test
failed; three first came back uncaught, and their tests were added or tightened. C1's 38 and C2a's 13
still fail when broken after C3's changes. Not run: `npm run test:host`, for which
`src/test/branchContinuation.spec.ts` and `engineChoice.spec.ts` are written.

### What landed on 14 Sep: M15 C2b — Codex's approvals, and finding the sites a task needs

`plan.md`'s M15 has the checks and every choice made; this is what a later session needs to know.

**Codex's requests are asked in the chat** (`src/engine/codex/approvals.ts`). A command, a file change, a request
for more access, a question, or a site Codex's commands were blocked from: each is drawn with only the decisions
RAVIS allows, one at a time in the order RAVIS opened them — a site ask behind Codex's own requests, since it never
holds Codex up — and the answer is checked again right before it is sent, so a Stop, RAVIS stopping the task or
another window answering first means nothing goes out. There is no "don't ask again": calibration's K11 showed
Codex's session approval outliving the step. RAVIS's refusals each do what `CLARVIS.md` §5.5 says: answered
elsewhere clears and says who, stopping clears silently, a narrowed list is drawn again, a site Codex didn't add is
asked again, and an answer RAVIS never received is asked again once it answers. **"Stop the run" is the Stop
button's stop.** Typed words that aren't an answer go to Codex and the question stays. Before an approved file
change, the files it touches are copied for **Clarvis: Undo Last Agent Run**; since 0.17.17 every file Codex
changed without asking is copied from the task's starting commit when its work is saved (`CodexGitGlue`).

**Unattended answers on its own only a quiet command or a change inside the project**, only while this window's
panel is there, and only when RAVIS offers `once`. Codex wraps every command in a login shell
(`/bin/zsh -lc "…"`), so commands are unwrapped before the gate judges them — without that, a wrapped `dd` read as
having no category.

**The fakes carry Codex's real requests** from calibration's transcripts (`src/test/fakes/calibrationRequests.ts`),
checked line for line against RAVIS's committed copies whenever the NERVIS-ecosystem checkout sits beside this one.

**Before a task starts, the sites it will likely need** (`siteScan.ts`): registry settings in `.npmrc`, `pip.conf`,
`pyproject.toml`, `requirements*.txt`, `Cargo.toml`, `.cargo/config.toml` and the `Gemfile`, `.gitmodules` URLs and
URLs in the brief, by RAVIS's own host rule. `siteAsks.ts` holds the owner's words for asking about them, before a
task and in one card while it runs. Phase 2 (below) wires both to RAVIS's R5 routes.

**The bowtie opens a fold-out** (the owner's decisions of 14 Sep; `media/bowtieMenu.js`). Its first item, **API
config**, does exactly what the bowtie did — the same `models` message, the same pickers. Under it a **Codex**
section: the models RAVIS lists, that model's efforts with the default marked, the note that a bigger model or
higher effort uses the ChatGPT plan's allowance faster, and one line of that allowance (the tightest window's
percentage left and its reset; the rest in the tooltip). The controls are disabled with one line when the coding
model isn't `ravis/clarvis-codex`; the allowance shows either way. RAVIS is read when the menu opens, never while
it's closed, and a pick is kept in the owner's own settings (`clarvis.codex.model`, `clarvis.codex.effort`). The
section is decided in `src/chat/codexMenu.ts` and wired in `codexMenuHost.ts` — named apart by more than case,
because this Mac's file system treats `CodexMenu.ts` as the same file. Its test runs the webview's script over a
stand-in document whose `innerHTML` throws.

### What landed on 14 Sep: M15 C2b+ phase 2 — sites before and during a Codex task, and each task's model and effort

Built against RAVIS's R5 contract (the fixtures copied from R5b, `6c3aef2`), with `FakeRavisRelay` checked against R5's
code (`bc1a103`). `plan.md`'s M15 has the checks, the choices and the guard proof.

**Before a task starts**, the hosts the scan finds that Codex doesn't allow yet are asked about once — **Allow and
start**, **Start without**, **Cancel** — before any branch or session exists (`runCore.ts`; `GET` and `POST
/api/v1/codex/sites`). Cancel starts nothing. Nothing is asked when nothing is found, or when RAVIS can't read its list.

**While a task runs**, the hosts one turn was blocked from are one card (RAVIS's `group_id`), each with Allow or Keep
blocked, plus Allow all. RAVIS reopens Codex's thread when the turn ends, and the chat shows "Reconnecting Codex so
newly allowed sites work (up to a minute)…" above the prompt until Codex has let go (`site.reopened`). Once every host
is decided, the window whose answer decided the last one carries the task on with a `carry_on` turn, after the work so
far is saved; RAVIS holds that turn until the thread is reopened. A run no longer ends at that settle while the owner
is still deciding. The status line is `AgentEvent`'s new `status` kind, shown as the panel's `run-status`.

**Each new task runs at the owner's model and effort** from the bowtie menu, held to what Codex lists, and the chat
says which ("Codex is using gpt-6-astra, at medium effort."). A model or effort RAVIS refuses is said in plain words,
with where to choose again; a choice made before Codex has listed its models is "Codex isn't ready yet", not a failure.

**Checked by breaking it:** 29 of 29 guards for approvals, 17 of 17 for the scan and 25 of 25 for the fold-out. Not
verified here: `RunSession.askCodex`, the undo copies and `codexMenuHost.ts` import `vscode` and were read, not run;
the fold-out hasn't been seen inside VS Code or code-server; nothing has run against a real Codex task.

### What landed on 14 Sep: Codex offers to set git up

**Found live that day.** In a folder without git, where the owner had declined Clarvis's own `git init` offer earlier,
Codex refused a task because the folder isn't a git repository. The offer stayed silent ("already declined, not asking
again"), and "git init then" went to Codex as a new task and was refused again: a loop with no way out from the chat.
`plan.md`'s M15 has the owner's decision, the checks, the choices and the guard proof.

**Now the refusal offers the fix.** Codex's refusal says what's missing in its own words ("This folder isn't a git
repository yet.") and the chat offers **Set up git here** and **Not now**, with one line saying the button runs `git init`
and makes a first commit (`src/chat/codexGitSetup.ts`). It is offered even when Clarvis's own offer was declined. Typing
"git init", "set it up" or "yes" answers it like the button, and never reaches Codex as a task; anything else typed is
read as the message it is. Once git is set up, the refused task carries on without being typed again. A folder whose
repository has no commit yet gets the same offer. Git not installed gets how to install it, and no button.

**What still comes first.** Workspace Trust and the engine choice refuse before any run; RAVIS says whether Codex may
run before any branch is tried; and before offering, `runCore` asks RAVIS about the folder with a read of its session
list, so a folder RAVIS would refuse (a protected repository, one outside the allowed roots) gets RAVIS's reason and no
offer. Clarvis's own pre-run `git init` modal is now asked only for Clarvis's own engine.

**Setting git up** is one vscode-free function for both offers (`src/agent/gitSetup.ts`): `git init`, then an empty first
commit that takes nothing already staged, on the branch name git picks. When `git init` or the commit fails, a `.git` it
had just made is taken back out, and the line says why; a missing name and email comes with the two commands that fix it,
and the button comes back. Then the Git extension is given up to 5 s to see the commit (`gitOffer.setUpGitHere`), since
Codex's branch is made through it. **The remembered decline** (`src/agent/gitOfferMemory.ts`) is forgotten only once git
is really set up through Codex's offer; Not now, no answer or a failure leave it, and **Ask About Git Setup Again** still
clears it.

**Checked by breaking it:** 29 of 29 guards, each broken in a scratch copy and caught by a test; the host spec
`codexGitSetup.spec.ts` saw the real Git extension pick up the new commit. Not verified here: `RunSession.offerGitSetup` and `codexGit.ts`'s wiring import
`vscode` and were read, not run; the refusal, the button and the carry-on haven't been seen together against a real Codex
task.

### What landed on 15 Sep: Codex builds on its earlier work, or starts fresh

**Found live that day.** In `live-test-c` (trunk `master`), Codex built a greeter on its own branch and the owner answered
"Leave it there". The follow-up, "Also add a --shout option to greet.py…", started a new Codex task on a new branch from
`master`: `greet.py` wasn't there, Codex wrote a second greeter beside the first, and one more idle task was left in RAVIS.
`plan.md`'s M15 has the owner's decision ("Ask each time"), the checks, the choices and the guard proof.

**Now a Codex task asks first** when earlier Codex work was left on its branch: **Build on `<branch>`** (at most three,
the branch the window is on first, then the most recent) or **Start fresh from `<branch>`** (`src/chat/codexLeftWork.ts`).
Build on switches the window to that branch and starts a `continue` turn with the new request on the same idle RAVIS
session, so Codex adds to its own work and keeps the conversation (`CodexRunCore.buildOn`); no session or branch is
made, and the run ends like any Codex run. Start fresh is today's start, and the earlier task stays idle to be offered
again. Typing "build on it", "continue" or "that branch", or "fresh", "start fresh" or "new branch", answers like the
buttons and never reaches Codex; anything else typed is the message it is. Unanswered, stopped, or a mode switch while it
shows: nothing runs. Unattended doesn't ask: it builds on the window's branch when that is left work, otherwise starts
fresh, and says which in one line.

**What counts as left** (`src/engine/codex/leftTasks.ts`): Codex may run; RAVIS lists the session as `idle`; this Mac's
token file holds its key and RAVIS accepts it for a view naming its branch (a task without a stored key isn't offered,
and no key is reissued to find out); the branch exists and isn't merged into the project's trunk. The trunk is the plan's
declared one, else the branch a fresh task starts from (`branchNames.startingBase`, now shared with `AgentBranch.begin`),
so a `master` project is asked about `master`, never `main`. **Refused in plain words:** switching to another branch while
the owner has uncommitted or untracked files, since the switch would carry them along (narrowed the same day, below:
untracked files the other branch doesn't have now come along, named). The earlier task is given the
chat's mode before its turn, and starts nothing if RAVIS won't.

**Clarvis's own engine** had the same gap; it asks the same question since the change below.

**Checked by breaking it:** 34 of 34 new guards, each broken in a scratch copy and caught by a test. A host test in `branchContinuation.spec.ts` moved a checkout from the trunk to the
branch Codex left through the real Git extension and committed the next change there (26 host tests passing). Not verified here: `RunSession`'s wiring
imports `vscode` and was read, not run; nothing has run against a real RAVIS or Codex task.

### What landed on 15 Sep: Clarvis's own engine builds on its earlier work, or starts fresh

**The gap.** Clarvis's own engine started every task on a new branch from the trunk. So after "Leave it there" a
follow-up never saw the earlier run's work: the gap Codex had until the change above. `plan.md`'s M15 has the owner's
decision ("Give Clarvis's own engine the same question"), every choice made building it, the checks and the guard proof.

**Now its tasks ask first, with the same question as Codex's**, from one module for both engines
(`src/chat/leftWork.ts`; the words are `clarvisLeftWork.ts`'s and `codexLeftWork.ts`'s).
- **Build on `<branch>`** runs the new task on that branch, on top of the earlier work. The model is told what that run
  was asked and said, and the branch's commits.
- **Start fresh from `<branch>`** is today's start, and it never stacks on the `clarvis/*` branch the window is on: a
  fresh start that can't begin at the trunk does nothing instead.
- Typed answers, nothing running when unanswered, stopped or dropped by a mode switch, and Unattended's pick all work as
  in the Codex question.

**What counts as left** (`src/agent/leftRuns.ts`). Every run of this engine that ends on its own branch writes a record,
`<git dir>/clarvis-left-work.json`, beside the checkpoint: 0600, written whole while the lock is held, and read by both
editors. Its branch must still exist and still hold that run's work, and either have commits not in the trunk, or be the
window's branch with the run's own files still uncommitted as it left them (the 13 Sep live case). Merged, deleted or
moved-away runs are dropped from the record. Branches Codex left are the Codex question's; a branch both engines left is
offered by both.

**The earlier run's own files.** When the window is on that run's branch, its own uncommitted files are committed there
first, with a line saying so: before building on it, before starting fresh, or before switching to another branch. They
come from the record, never `git status`, and are never the owner's files in flight. A file changed since refuses a
switch; on the window's branch it stays the owner's, and the line says it wasn't committed.

**Changed for both engines: what a branch switch may carry.** Ignored files don't count. Untracked files the other branch
doesn't have come along, named in a line of their own (`__pycache__/`). Tracked changes, and untracked files the other
branch also has, refuse, named. For Codex that changes 0.17.3: an untracked file no longer refuses a Build on, and a
Start fresh from a `clarvis/*` branch is now checked too.

**Checked by breaking it:** 75 of 75 new guards, each broken in a scratch copy and caught by a test. Three of them were
in the extension host, where two tests added to `branchContinuation.spec.ts` ran the real own engine with a stand-in
model (28 host tests passing):
- a Build on moved the window to the earlier run's branch through the real Git extension, told the model that run's task
  and summary, and committed on top;
- a Start fresh that git couldn't begin at `main` did nothing.

Not verified here: `RunSession`'s wiring imports `vscode` and was read, not run. No task of Clarvis's own engine has gone
through the question in VS Code or code-server.

### What landed on 15 Sep: Clarvis's own engine uses the owner's skills

**The owner's decision.** Skills are for the models that aren't Codex too, and RAVIS alone knows which skills exist and
which are switched on (RAVIS 0.27.0, `skills.json`; the owner switches them on NERVIS's Skills page). `plan.md` §4.6,
"Skills", has the design, every choice made building it, and the checks.

**What a run does now** (`src/agent/tools/skillTools.ts`, with the section's words in `agentPrompt.ts`):
- **At its start**, when the coding model goes through RAVIS, the run reads the list of skills switched on, once, with a
  5-second timeout. It adds a short section to its instructions: one line per skill, how to use one, that `readSkill`
  works through the editor even though commands have no network, and that a skill never overrides Clarvis's rules.
  Nothing is added when no skill is on, or when RAVIS isn't the provider.
- **The section is capped**, because every call resends it: 854 characters for two skills, and about 2,270 at most.
  That is roughly 4% and 12% of the ~4.9k input tokens a call carried in the 13 Sep build.
- **`readSkill`**, a new tool offered only then, reads a skill's `SKILL.md`, or a file inside it, from RAVIS at that
  moment. Since 0.17.6 it hands the text back as the skill's instructions, to follow for how the covered parts of the
  task are done, after the owner's request and plan.md's conventions and never widening the task, and never as the
  owner speaking. It reads only, is never asked
  about, and is logged by skill and file. A run's first eight reads spend no step, and every refusal is a plain result.
- **When the list can't be read**, the run goes on without skills, with one log line. The chat hears one line only when
  this window last saw skills switched on, and only once until a list is read again.
- **Not for** answers, plain chat, the tool check or any background call. Not for Codex either: RAVIS gives Codex its
  skills itself.

**The fixtures** were copied again from NERVIS-ecosystem 6eb9149 (NERVIS 0.32.0), which changed `codex-admin.json` and the
manifest after the b5bed2c sync.

**Checked by breaking it:** 66 of 66 new guards, each broken in a scratch copy and caught by a test. Nine of them were in
the extension host, where a test added to `branchContinuation.spec.ts` ran the real own engine with a stand-in model and
the fake RAVIS (29 host tests passing). There are 31 new tests in the fast suite (2061 passing).

Not verified here: the glue that hands a run its skills (`engineHost.runSkillsLookup`, `RunSession.clarvisRunner`,
`clarvis.runTask`) imports `vscode` and was read, not run. No run has read a skill from the live RAVIS, in VS Code or in
code-server.

### What landed on 15 Sep: skills as slash commands, and the chat box's suggestions

**The owner's decisions**, with the peer session's rules the same day. `plan.md` §4.6, "Skills as slash commands, and the
chat box's suggestions", has the design, every choice made building it, and the checks.

**What the chat does now** (`src/chat/skillCommands.ts` decides, `ChatService` carries it out):
- **`/skill-name …` uses a switched-on skill by its name**, and `/skill <name or id> …` always reaches one. A built-in
  command wins over a skill of the same name, every alias counted. When two skills share a name, the short form names
  both full ids and runs nothing.
- **Nothing typed by mistake reaches a model.** Each of these gets one plain line: an unknown command, a skill named
  without a request, a list RAVIS couldn't give, and a skill typed while planning, while a run is going or while a
  question waits. A path, or a slash mid-sentence, routes as before.
- **The skill is checked against RAVIS's list as the message is sent**, never the pop-up's copy.
- **The request goes where it would without the slash.** A job for Clarvis's own engine has the skill's `SKILL.md` read
  first, then loaded into the run's instructions, framed as `readSkill` frames a skill, and capped at 6,000 characters.
  An answer gets it too. A failed read runs nothing. Each logs what the skill adds to every call: 669 characters (~167
  tokens) for the fixture's skill, about 6,560 (~1,640 tokens) at the cap.
- **A Codex job is sent Codex's own mention**, `$name request`, with one line that Codex uses it if it's switched on for
  Codex on the Skills page. Codex 0.154 collects `$name` from a turn's text, as its documentation, its binary and its
  source all show.
- **`/help` lists** the built-in commands with their descriptions, then the skills and how to type each. `/manual` opens
  the manual.
- **The suggestions pop-up** (`media/chat.js`, rows from the host):
  - It shows while the box's first word starts with `/`.
  - Up and Down move, Enter or Tab completes, Escape closes, and a click completes too.
  - **Since 0.17.8:** the row whose command is exactly what has been typed takes the highlight, wherever it sits, so
    Enter runs it. Found live on 16 Sep: `/clearkey` is listed above `/clear`, so `/clear` and Enter filled in
    `/clearkey`, which removes the stored Fish Audio key. A partly typed word still takes the first row.
  - It is a listbox with `aria-activedescendant`, and RAVIS's words are text nodes.
  - Its skills are read when the panel opens, when the window regains focus, when the settings change, and while typing
    at most once a minute (`src/chat/slashSkills.ts`).
  - Enter while an input method composes is left to the input method.

**Checked:** 46 new tests in the fast suite (2108 passing), and one in the extension host, where the real own engine ran
with the invoked skill in a run and an answer (30 host tests passing). **Checked by breaking it:** 124 of 124 new guards,
each broken in a scratch copy and caught by a test, 118 in the fast suite and 6 in the extension host.

Not verified here: `ChatService`'s routing of a skill command, `RunSession.run`'s hand-off, `Replier`'s answers and the
panel's refresh events import `vscode`, and were read, not run. No skill command has run in VS Code or code-server,
against the live RAVIS or against Codex.

### What landed on 16 Sep: every model request names itself, on both adapters

CLARVIS.md §6.5 asks Clarvis to send RAVIS `trace_id`, `request_id`, `session_id` and `workspace_id`. Two travelled, and
only through the OpenAI-compatible adapter.

- **`x-request-id` on every model request** (`lineageHeaders` in `src/model/lineage.ts`), a fresh 32-hex id per call,
  the shape RAVIS mints for a caller that sends none. Unlike the trace and the session it is never omitted: every
  request is one. RAVIS reads it as sent, so its route decision, events and log lines carry Clarvis's id.
- **The Anthropic adapter sends the same three headers.** It sent none. It only ever reaches Anthropic — RAVIS serves
  no `/v1/messages` — so nothing reads them yet, but a request is now the same request whichever adapter carries it.
- **`workspace_id` still does not travel**, on purpose: runbook §4.3 lists no header for it and RAVIS reads none, so
  sending one would be a contract nobody agreed to. The salted id already reaches NERVIS with the Bridge registration.

**Checked:** 3 new tests and 2 updated in `src/model/lineage.test.ts`; breaking the request id, reusing one id, or
dropping the Anthropic headers each failed them.

**Then, the same day (0.17.10), what the first whole trace showed about Clarvis's own events.** A Clarvis chat turn
was seen in NERVIS as one trace with RAVIS (trace `7886440e…`), and two things about Clarvis's side of it were off:

- **Its events name the session too.** `clarvis.chat.*` and `clarvis.agent.*` now carry the `session_id` their model
  requests send as `x-session-id` (runbook §4.3): `ModelService.sessionFor(role)` is read when a plain chat turn
  starts (`Replier`) and when the tool loop knows its role (`AgentRunner`, chat for a read-only answer, agent for a
  job), carried by `Activity` beside the trace, emitted by `EventStream.emit` and forwarded top-level by
  `eventBody` — omitted when empty. A Codex run has no model session in Clarvis and names none.
- **Its timestamps keep their milliseconds.** `occurred_at` was cut to whole seconds, so the Clarvis bar sat up to a
  second off and the turn read as ending before the RAVIS call inside it. `timestamp()` for the MEP surface is
  unchanged.
- A request id is still not on these events, on purpose: a turn can make several requests, and its start event is
  published before any of them.

**Checked:** 5 new tests and 2 updated across `events`, `eventForwarding`, `activity` and `publish`; each of 7 guards
(an event, the forwarding, the activity or the publisher dropping the session, an empty session sent, a session
wiped by a later `noteTrace`, whole seconds again) failed one of them.

**16 Sep (0.17.11): the rest of §6.4's events, except tasks.** The Bridge now publishes
`clarvis.model.requested/completed/failed`, `clarvis.tool.started/completed/failed/refused` and
`clarvis.diagnostic.changed` (plan.md M14, "Amended 16 Sep"). Where each comes from:

- `src/model/callWatch.ts` (new, `vscode`-free) wraps every stream `ModelService.stream` and
  `streamWithTools` hand out; `ModelService.watchCalls` is how `extension.ts` passes them to the
  `Activity`. `CompletionRequest.requestId` carries the id both adapters now send.
- `AgentRunner.dispatch` tells each tool call; `refusal()` and `execute()` were split out of it.
  `toolEnding()` in `activity.ts` is the rule that a call which asked the user never ends as failed.
- `src/bridge/problemCounts.ts` (new, `vscode`-free) counts and paces; `wire.ts` subscribes to
  `onDidChangeDiagnostics` only while the Bridge runs.
- `Activity.note()` / `observeNotes()` is a second channel beside `observe()`; `publishNotes` in
  `publish.ts` maps it; `forwarded()` in `eventForwarding.ts` keeps the two beginnings off NERVIS.
- `clarvis.task.*` was not built then: what a Clarvis task is had not been decided (see 0.17.14).
- **0.17.12, the same day:** a forwarded event with a `request_id` in its data carries it on the envelope
  too (`eventBody`), where RAVIS puts its own, so NERVIS stores Clarvis's model event and RAVIS's route
  decision under one request id.

**Checked:** 26 new fast tests (`callWatch`, `problemCounts`, and additions to `activity`,
`publish`, `eventForwarding`, `Bridge`, `lineage`), the real runner's tool events in
`branchContinuation.spec.ts`, and the real `ModelService` in `modelEvents.spec.ts`; each of 14
guards broken one at a time in the build failed a test.

**16 Sep (0.17.13): Codex answers can no longer overtake each other.** In Unattended, when several of
Codex's requests arrived together, RAVIS's "resolved" event for one answer could start the next answer
before the first had come back, and a slow answer was then overtaken (a `runCore.test.ts` failure, once,
under full-suite load). `CodexApprovals` now sends one answer at a time (`sending`, `sendAlone`), and
`FakeRavisRelay.delayArrival` makes the test fail every time without the fix. `npm run check` passed four
runs in a row afterwards (2,145 each).

**16 Sep (0.17.14): a handover from NERVIS is followed to the end.** The owner decided that a Clarvis
"task" is a task NERVIS handed over. NERVIS now writes an id into `clarvis-task.md`
(`<!-- nervis-task-id: nt_… -->`); `parseNervisTask` reads it, and `src/planning/nervisTaskTrack.ts`
remembers it in `workspaceState` (`clarvis.nervisTask`) because the brief is deleted once planning has
begun. The Bridge publishes `clarvis.task.started` with the stage (`planning` at pickup, `building` and
`paused` around each run of the plan, via `RunSession.onPlanRun`) and `clarvis.task.completed` with
`built` when the project is finished (`ChatService.announceProjectFinished`). NERVIS joins these with its
own handover records on its Clarvis screen. **Checked:** 9 new fast tests (the tracker, the id, the
payload, the trace, forwarding); each of 7 guards failed a test. The `ChatService`/`RunSession` wiring is
read, not tested.

**16 Sep (0.17.15): the status says more.** `/v1/status` now adds, when known, the editor's problem
counts, the last build and test run (VS Code tasks in the Build or Test group only, `src/bridge/checks.ts`),
the last model request (its request id, model, provider and result), the handed-over task and its stage,
and the event cursor (`Activity.statusFacts`, `recordCheck`; `protocol.ts` `StatusReport`; `wire.ts`
listens to `onDidEndTaskProcess` while the Bridge runs). NERVIS 0.34.10 shows them on the window card.
**Checked:** 6 new fast tests; each of 7 guards failed one.

**16 Sep (0.17.16): the agent's reads are fenced.** CLARVIS.md §9 says retrieved content is evidence,
never intent, and until now only one chat path used `chat/fence.ts`. `src/agent/toolFence.ts` wraps what
`readFile`, `listFiles`, `search`, `readDiagnostics`, `gitStatus`, `gitDiff` and `runCommand`'s output hand
back (`AgentRunner.invoke`, `reportCommand`) between the fence markers under a one-line heading; a marker
inside the content is removed, a path in the heading is cleaned, and Clarvis's own words and `readSkill`
stay outside. The rule is stated once in both system prompts (`TOOL_OUTPUT_RULE`). **Checked:** 5 fast
tests and a host spec with a planted instruction (a read, a listing, two searches and `cat` through the
real runner); each of 6 guards failed a fast test, and unfencing the file read or the command output each
failed the host spec.

**17 Sep (0.17.17): five flaws from the owner's attended session** (code-server 4.137.0, Firefox; the
NERVIS-ecosystem runbook's §15 E2E item has the record).
- *A folder trusted after the window opened* now starts the Bridge and the branch flow then, instead of at
  the next reload (`src/agent/afterTrust.ts`, `hostTrust.ts`; `BranchFlowWatcher.attachWhenGitArrives`).
- *`clarvis.agent.completed` and the other endings carry the operation's duration* — they carried the
  just-entered state's age, 0 (`ActivityChange.operationMs`).
- *Undo covers every Codex change.* A change Codex made without an approval prompt was on disk before
  Clarvis heard of it and had no copy; the copies now come from the task's starting commit
  (`GitFacts.fileAt`, `Checkpoint.captureContents`), and an approved change's copy goes into the same
  record instead of a second one that wiped the first (`undoCopies` is gone). The undo's outcome, and
  "nothing to undo", are said in the chat as well as in a notification (`src/agent/undoCommand.ts`).
- *`Clarvis: Turn the Bridge On or Off`* writes the user value of `clarvis.bridge.enabled`, which
  code-server's settings screen doesn't show (`src/bridge/toggle.ts`); the setting stays machine-scoped.
- *A closing window deregisters from NERVIS.* `deactivate` returns the Bridge's stop, so VS Code waits for
  the `DELETE` (`src/bridge/slot.ts`); before, the host ended first and NERVIS kept the window live until
  its lease ran out.
**Checked:** 17 new fast tests (2,182 passing) and one host spec (33 passing on Code 1.137.0), where a real
Codex save with an unasked edit, an added file and a file copied at the start was undone; with the
starting-commit copy switched off it failed (1 restored, 0 deleted). The elapsed-time test failed at 0
before the fix. Not yet seen live: the deregistration and the trust start under code-server.

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
npm test               # node's built-in test runner, no framework — 2108 tests (15 Sep, after skills as slash commands)
npm run lint            # eslint
npm run package         # esbuild bundle + vsce package -> clarvis.vsix
npm run test:host       # @vscode/test-electron, needs a display — see below
```

**Manual release checklist** — what CI and `test:host` genuinely cannot cover, so it
doesn't quietly become nobody's job (from the 16 Aug review):
- [ ] Windows: sandbox falls back correctly (no `sandbox-exec`/`bwrap` there — see
  `sandboxProfile.ts`), and the network-confinement asks-once dialog appears.
- [x] VSCodium, not just VS Code: the extension activates — 0.12.0 installed and
      activated with a clean exthost log, chat running, and the untrusted-folder
      degradation observed (`docs/code-server-matrix.md`). **The panel itself
      is now confirmed too** — the operator reports having watched it render
      correctly under VSCodium on multiple separate occasions since (2026-09-06),
      closing the one half a log could not prove on its own.
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

**M14, the NERVIS Bridge, is built and driven end to end — but never inside an extension
host (29 Aug).** Every code exit item in `plan.md` §7 M14 is ticked, and two real Bridges
were run against a real NERVIS from node: both registered, NERVIS read each one's
`/v1/status` with the token it issued, and its dashboard drew what each window was doing.
What has *not* happened is any of it running inside VS Code. That is the same code and not
the same environment, and this repository's own history says that distinction is where
confidently-verified fixes turn out not to work.

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
