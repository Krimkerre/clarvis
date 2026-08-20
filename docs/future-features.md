# Future features — what is deliberately not in v1

*Opened 19 Aug, when the goal became **a stable first release** rather than a more complete
one. This is a decision record about what is being left out and why, not a second copy of
the spec: each item points at the `plan.md` section that specifies it. If this file and
`plan.md` disagree about what something **is**, `plan.md` is right — this file only claims
when it happens.*

**The bar this file exists to protect.** v1 ships when Clarvis does not lose what you told
it, does not act against what you decided, and does not leak its own internals into your
face. Everything that makes it *better* rather than *correct* lives here.

**Split 20 Aug into two sections**, because the file had been mixing two different kinds of
"not now": genuinely new capability nobody has built, and defects already observed in
current behaviour that just don't clear the release-bar bar. They get triaged the same way
(below) but they are not the same kind of debt — a feature is scope, a bug is quality.

---

## Triaging the next one

*Added 19 Aug. Quirks will keep arriving from using the product; this is how each one gets
filed without relitigating the boundary every time.*

**Ask these in order. First hit wins.**

1. **Does it lose or overwrite something the user said?** → blocker. (F2, F3.)
2. **Does it act against, or silently decide for, something the user decided?** → blocker.
   (F5, F1.)
3. **Does it show the machinery** — internals, reasoning blocks, jargon, or a truth that
   only exists in the log? → blocker. (M8i part 1.)
4. **Otherwise: is the product *wrong*, or merely *worse*?** Worse ships. (F4, F6.)

Then two overrides, both of which beat the answer above:

- **Cheap beats correct filing.** If the fix is a revert, a deletion, or one line at a seam
  that already exists, do it now regardless of which bucket it landed in — a triage argument
  that costs more than the fix is waste. This is why M9h part 4 is in v1 while parts 1–3 are
  not: same finding, different price.
- **Predicted is not observed.** A quirk reasoned about but not seen gets verified before it
  is filed either way. M8i part 1 sat as *predicted* until a real MLX model could confirm it.

**Two things that are never blockers**, however true: *"it would be better if…"*, and a
defect whose only evidence is that the code looks like it could misbehave. This project has
a written record of confidently-wrong fixes that passed review and failed live; a fix
without an observation is the same mistake wearing different clothes.

**Where each one goes.** A blocker becomes a checkbox in `plan.md` §7's M11 release bar. A
deferral becomes a section in this file — under **Future features** if nothing is broken,
under **Known bugs** if something is — naming the milestone that will specify it or the
finding that observed it. Either way, the observation itself — what happened, the log
evidence, why it matters — goes in `clarvis-firstrun/FINDINGS.md` first, while it is fresh,
and is triaged from there.

---

# Future features

*New capability nobody has built yet, or a deliberate scope decision. Nothing here is a
defect in current behaviour — Clarvis does what the spec says; the spec just says less than
it eventually will.*

## Deferred: the interview redesign (M9h parts 1–3)

**What:** infer rather than ask — a fact/preference split across the eight topics, a
`shouldAsk()` keyed on whether the model has a *basis* for its answer, and assumptions
marked in the draft plan where the user reviews them. `plan.md` §7, M9h.

**Why deferred:** it is a redesign of the front door, and it depends on runbook session 4
(MLX across three model tiers) to set how far inference can be trusted on a weak local
model. Neither is a week's work, and neither is required for the product to be *correct*.

**What ships in v1 instead — M9h part 4 alone.** `challengeAnswer()` is narrowed back to
firing only on an answer that is genuinely unusable, reverting the 13 Aug generalisation
that applied §4.9's "challenged once, then honoured" rule — written for the language
question — to all eight topics. That revert is small, and it removes most of what made the
interview feel like an interrogation.

**The risk of deferring, stated rather than buried.** The user's words on 19 Aug were *"nag
machines get discarded quickly"*, and §9's success criteria include keeping Clarvis running
for a week without muting him. For a personality-led product the first session **is** the
product. Part 4 is the bet that most of the damage is the frequency, not the design. If a
week of real use after v1 says otherwise, M9h parts 1–3 stop being deferred.

## Deferred: the character reaching into artifacts (M9h parts 1–3)

**What:** `agentSystemPrompt()` is built on `characterWith(...)`, so the model writing files
into the user's project carries the butler character block. Asked for a compliment script,
it produced twelve compliments about programming — nobody said who they were for, and every
signal available said "a developer".

**Why deferred:** here it is charming, and the assumption is visible in the artifact and
rewritten in seconds. That is the opposite of F1, where a silent assumption was a *language*
and its consequences arrived three questions later.

**Why it will not stay deferred forever.** §2.2's one-voice-everywhere rule was written
about **Clarvis's own surfaces** — briefing, gate copy, findings, chat. Whether it extends
to **content written into someone else's project** has never been asked, and the answer is
obviously different for error messages, README text or UI strings in a product that is not
his. Two things to weigh with M9h: *who is this for* as a ninth interview topic — inferred
and stated rather than asked, by M9h's own rule — and whether the character should be
attenuated when generating user-facing content as opposed to talking to the user.

## Deferred: the safety model covers the build, not the artifact

**What:** every safety mechanism in this product binds Clarvis's **conduct**, and none of
them look at what it **writes**. `resolveInWorkspace()` refuses paths outside the folder;
`sandbox-exec`/`bwrap` deny writes and network; `Gate.ts` stops destructive, outward-facing
and privileged *commands* at the tool layer. All of that governs what Clarvis executes.

Writing a file containing `os.system("rm -rf /")` passes every one of them, because at
write time the string is inert. The danger arrives later, when the user runs it themselves,
unsandboxed, on their own machine.

**Why it matters, in this project's own terms.** §9.9 — *"never once finds that Clarvis
changed something they didn't ask him to change"* — is about the workspace during the run.
§1's one-sentence privacy pitch is about what leaves the machine while he works. Nothing
covers the user after the run ends, and the asymmetry is stark once named: **Clarvis is
careful about his own conduct and says nothing about the artifact he hands you.** The same
shape as the character-bleed entry above, one level more serious.

Raised 19 Aug, from the observation that the sandbox binds the builder and not the built
thing.

**Why it is deferred rather than a blocker.** *Predicted, not observed* — the triage rule's
second override. No run has produced dangerous generated code; the gap is real in the
design and has never fired. It also needs design rather than a fix, and the obvious design
is the wrong one.

**The obvious wrong shape.** A general "is this code dangerous" scanner. It cannot be
complete (the question is undecidable), it fires on `subprocess`, `os.remove` and `fetch`
in perfectly ordinary programs, and a warning on every file is the nag machine this project
spent a whole day removing. For §6's audience — normies building small things — a false
positive costs more than it does in a security tool aimed at professionals who expect noise.

**Two shapes worth weighing instead, and they compose:**

1. **Ask the gate about content, not just commands.** `Gate.ts` is already pure, already
   tested, and already knows what a command it would refuse looks like. A file being written
   that *contains* such a command is a narrow, deterministic question with an answer that
   cannot drift from the runtime one, because it is the same code. Not a scanner — the same
   deny-list, asked a second question.
2. **Say it in the read-back.** M9d3 already has Clarvis read his own code back after a
   milestone, and that is a report the user reads rather than a dialog they dismiss. *"This
   writes outside the project folder"* or *"this makes network calls nothing asked for"*
   belongs there, as an observation, not a block.

**Recommendation: (2) as the primary, (1) narrow beside it.** Say, do not block — because
plenty of legitimate projects are *supposed* to contain dangerous code. Someone writing a
deployment script, an installer, or a disk utility has asked for exactly the thing a
scanner would refuse, and a product that argues with them about it is wrong rather than
safe. The value is catching the **unrequested** case, and a report catches that without
having to be right about intent.

**Open question that decides the shape:** does the interview know enough to tell a
deployment script from a compliment printer? `what-it-does` and `scope` are answered before
anything is built, so it may — which would make this another customer for M9h's
infer-and-state work rather than a mechanism of its own.

## Deferred: provider-side reasoning control (M8i part 2)

**What:** `thinking` / `reasoning_effort` per provider. `plan.md` §7, M8i.

**Why deferred:** explicitly not approved at sign-off. One toggle cannot mean the same
thing across five providers — Qwen3's is `/no_think` in the prompt, not an API — and a
switch that silently does nothing on some models is worse than no switch. **M8i part 1
(stripping reasoning out of the transcript and the spoken output) is a v1 blocker and is
not deferred.**

## Deferred: model-family recognition (M8j)

**What:** a regex table over model ids seeding per-family defaults. `plan.md` §7, M8j.

**Why deferred:** signed off as *design constraints settled, build deferred* — a family
table with no caller is speculative configuration.

**Four callers now want it, which is the argument for building it** *(count corrected
20 Aug — this section said "a second caller" while `CURRENT_STATE.md` said three, and both
were behind)*:

- **F14 — longer deadlines on a local provider.** A 27B via LM Studio missed both
  personality deadlines, so the opening and the briefing fell back to the written bank. The
  deadlines are tuned for API latency; a local model is slower by nature and nothing waits
  on a briefing the way a modal does. **F14's telling half shipped 20 Aug** — the user is
  now told once when it happens. This is the half that stops it happening.
- **F16 — smaller step budgets** for a question that does not need a tool loop.
- **F18 — knowing which models can carry the voice at all.**
- **F21 — possibly the opposite nudge**: a weak model that gives up after one tool call may
  need *more* steps, not fewer. One data point; not yet confirmed.

"Local provider → longer deadlines" is exactly the *default seeded by family, never a
capability asserted* that M8j was scoped for, and a smaller ask than M9h's `shouldAsk`.

## Deferred: read a provider's own capability data instead of probing for it (F27)

**What:** LM Studio's `/api/v0/models` — the same port Clarvis already talks to — publishes
`state`, `max_context_length`, `quantization` and a `capabilities` array carrying
`tool_use`. `supportsTools()` answers that last question by spending a real one-tool,
one-token request instead.

**The code's own comment says why it does that**, and it was right when written: *"a
one-tool, one-token request is the only honest test: `/v1/models` reports nothing about
tool support."* True of `/v1/models`; false of `/api/v0/models`, which is a newer,
provider-specific endpoint.

**Why it is worth doing:** it removes a spent request per model per session, it is faster
than a round trip, and it removes the mechanism behind the known **cached-401** bug — an
access error recorded as a capability verdict. A published field cannot be misread that way.

**The rule has to be asymmetric, and this is the part to get right.** `phi-4-mini-instruct`
publishes `tools: no` and was measured producing a **well-formed tool call** on the same
machine an hour earlier. So: **trust a published `yes`, probe on a `no`.** Strictly better
than probing blind, and honest about which half is evidence.

**Why deferred:** the current path works and only costs a request — nothing is lost, nothing
acts against the user, no internals leak. It is also **one provider's extension**: Ollama and
llama.cpp publish different things or nothing, so this is a per-provider enrichment behind
the existing interface, never a replacement for `supportsTools()`.

## Deferred: notice when the local server's own settings are fighting us (F28)

**What:** LM Studio ships `unloadPreviousJITModelOnLoad: true`, a 1-hour JIT TTL, and `high`
loading guardrails.

**Corrected 20 Aug:** this originally claimed the first setting evicts one model when the
other loads, making F14 fire permanently by configuration. **Inferred from the setting's
name, never tested, and false as observed** — three models stayed resident at once, two of
them auto-loaded, with it on. Withdrawn; see F28.

**What is real** is the cold-load stall: the first request to a model that is not resident
takes ~**5.3s**, past the 5s opening deadline. A warm-up problem rather than an eviction
one — and the reason `lmStudioTune.ts` warms models at startup instead of waiting.

**What Clarvis must not do:** write those settings. They live in another application's
config file outside the workspace; changing them silently breaks §9.9 — *never once finds
that Clarvis changed something they didn't ask him to change* — and is exactly what
`resolveInWorkspace()` refuses on principle. It would not work anyway: LM Studio rewrites
that file on quit, clobbering edits made while it runs.

**What it could do:** the `gitOffer.ts` shape — diagnose the specific cause, name the
specific fix, no button that could only fail, remember a decline forever. Detection is free
and read-only, since `/api/v0/models` reports `state`: Clarvis can see the model it is about
to use is not resident and say what that will cost *before* spending a deadline on it.

**Partly built, 20 Aug — the load-parameter half shipped.** `lmStudioTune.ts` warms the
configured LM Studio models at startup with `--parallel 1`, on the reasoning the user gave
when signing it off: *choosing a local provider is itself the signal that it will be used*.
It replaces a just-in-time load that was going to happen anyway, with better parameters —
the same event, not a new action. Three gates: LM Studio only, a setting the user can turn
off (`clarvis.model.tuneLocalLoads`), and **never a model that is already loaded**, because
one the user loaded themselves is theirs, settings and all. Verified against a live server:
cold → both loaded at `parallel=1`; warm → does nothing; server down → logs and carries on.

**Only `--parallel`, and only because it was verified.** `--context-length` is silently
ignored on MLX (`autoFit` appears to win) and speculative decoding lives only under
`llm.load.llama.*`. Passing either would make Clarvis the fourth thing in this stack to
quietly ignore its own options.

**The unload half shipped 20 Aug (late), at the user's request.** `lmStudioTune.ts` said
"never unloads anything" as a deliberate bullet; that is now "unloads only what it loaded
itself, and only once nothing wants it". The argument is the same one in reverse — choosing
a local provider is the signal it will be used, so switching a role to a hosted provider, or
to a different local model, is the signal it will not be, and a 4-8 GB model idling on a
24 GB machine is worth reclaiming sooner than LM Studio's one-hour TTL manages. One pure
rule decides it (`staleLoads`: what we loaded, minus what is still wanted), which covers both
cases, and the ids come from a session-scoped record of what Clarvis loaded — **never from
what happens to be resident**, because "resident and unwanted" also describes a model the
user loaded for their own chat. Verified against a live server: loaded, switched, gone.

**What stays deferred:** noticing that LM Studio's *own* settings are hostile — the JIT
eviction, the TTL, the guardrails — and offering the fix in `gitOffer.ts`'s shape. Those
live in another application's config file and Clarvis must never write them. The honest
half of *that* — telling the user the local model is missing these deadlines — **shipped as
F14's fix** the same afternoon; this would say *why*, which is better, but F14's notice is
not wrong without it.

**The cheap half is already done:** `media/MANUAL.md` gained *Making LM Studio quick*, naming
all four settings — and correcting a claim that two models "will swap them in and out and
everything gets slower", which described a **setting** as if it were a limitation.

## Deferred: the model that works is a *build*, not a model (F30, F31, F32)

**What happened.** `granite-4.0-h-tiny` — IBM's 3.9 GB MoE, the fastest model measured here
and the only small mixture-of-experts with a tool path and no reasoning — passed the
benchmark 3/3 on tools and then lost the filename on **8 of 8** ordinary requests. The model
was blameless: it emitted a correct call whose `arguments` were a JSON string, and **LM
Studio's MLX parser discarded it** (F30). The same weights in the GGUF build, on llama.cpp,
get 8 of 8 and recover from a bad path — at roughly twice `qwen2.5-coder-7b`'s rate.

**Nothing here is fixable in Clarvis**, which is why this is a register entry rather than a
blocker. The call is destroyed inside the server before it is streamed; the extension sees a
`readFile` with no `path` and cannot tell that from a model that fumbled. Reporting it
upstream is the only repair, and LM Studio's tracker already carries this class of bug for
three other model families.

**What it changes here is the method, and that part is done:**

- **The harness measured a mode the product never uses** (F31). Both tool tests sent
  `stream: false`; Clarvis streams everything. Fixed — they stream and reassemble deltas as
  `absorbToolDeltas` does, run eight phrasings instead of one, and score a call whose
  arguments never arrive as its own outcome rather than as a pass or as silence.
- **`screen.py` was rewritten** to *render* a chat template rather than grep it (F32), with
  a `--validate` mode checked against models whose behaviour was established by running
  them. Six defects in the new version were caught that way before it was trusted.
- **A repack can ship a different template than its upstream model** (F32):
  `LFM2-24B-A2B` renders a tool call upstream and cannot in its LM Studio build. Screen the
  repository you will actually download.

**Every earlier rejection was re-checked against this (F33), per build rather than per
model: all six hold.** No model gained a tool path. The sweep did find two more holes in the
screen — it could not read GGUF templates at all, which is the runtime that makes granite
work, and it reported a repository's every quantisation as one model's size. Both fixed.

**And a rejection belongs to a role, not to a model (F34).** `lfm2.5-2.6b` was rejected as
unusable — it is a forced-reasoning model that produces nothing visible inside a deadline,
and no `enable_thinking` switch can change that. On the *agent* path, which has no deadline,
the same build makes well-formed tool calls, recovers from a bad path, and finishes a
two-file editing job with a written summary. It is inconsistent about it — 4 of 7 runs, and
the failures loop on absolute paths — and is **not** recommended; what survives is that the
talking role and the working role were being judged by one list. `agentrole.js` in the
runbook repository now measures the second, using the product's own agent prompt, tool
schemas and edit rules rather than copies of them.

**What stays deferred.** Nothing in the product. `docs/benchmarks.md` carries the numbers and
the method; if a benchmark command is ever built (next section), the streamed tool test, the
several phrasings and the working-role loop are the parts worth keeping, because the
single-phrase unstreamed check is what passed a broken build.

## Deferred: a benchmark command, because `voiceCheck` is most of one already

**What:** `Clarvis: Debug — Benchmark Model`, beside `Clarvis: Debug — Voice Check`. Run
it against the configured model, get a markdown report, switch model, run again, compare.

**Why it is cheap:** `voiceCheck.ts` is already the harness. It runs fixed scenes through
the configured model, applies a spoken-length ceiling, detects parroted calibration
examples, and **already calls `ungroundedClaims()`**. What a benchmark adds on top is
mostly instrumentation of a loop that exists:

| measurement | cost | note |
|---|---|---|
| timings at the caps Clarvis actually reads to (40 / 300 / 400 chars) | trivial | a timestamp at each threshold in the existing streaming loop |
| grounding, length, parroting | **free** | already implemented and running |
| tool-call reliability over N attempts | small | `streamWithTools` instead of `stream`; same provider layer |
| multi-turn tool follow-up | small | one extra round-trip with a synthetic tool result |

**Measure time-to-cap, never total generation.** Every timed caller stops reading at a
character cap — `Voice.collect` at 300, `LiveQuips.collect` at 400, `intentModel` at 40 —
so a verbose model is not penalised for verbosity nobody waits for, only for being slow to
reach the cap. A scratch harness written on 20 Aug measured total generation first and had
to be thrown away: it made a model that emitted nothing for 27 seconds look merely slow,
and libelled a chatty-but-quick one.

**The multi-turn follow-up is the part worth having**, and the part no one-shot scene can
see. **F17** was not a model that could not write code — it was a model that malformed a
path, was told plainly *"use listFiles to see what is"*, and reissued the same call four
times. Replaying that exchange and classifying what comes next — used-the-result, retried,
gave-up — measures the single failure that decides whether a local model can hold the agent
role at all.

**One thing that must not move in: executing generated code.** The 20 Aug scratch harness
runs `dedupe()` against test cases in a subprocess, which is fine for a script on a
developer's own machine and is *not* fine inside the product — that is Clarvis executing
untrusted model output, precisely what `Gate.ts` and the sandbox exist to prevent, and it
is the open *safety model covers the build, not the artifact* item above. Either it goes
through the sandbox properly, or the in-product version reports the code for a human to
judge and does not run it.

**Keep the measurement pure.** Timings-to-cap, verdict classification and report formatting
belong in a `vscode`-free module beside the command, not inside it — this session lost two
fixes (F15, F22) to logic that lived where no test could reach it, and gained tests for
`branchNames.ts` and `thread.ts` only because a defect dragged them into the light.

**Why deferred:** the runbook answers *"is the local agent path good enough to offer?"* once,
by hand, in session C. This would answer it repeatably, for any model, in a command — which
is better but is not what stands between here and v1.

## Deferred: the milestones already marked stretch

Unchanged by this decision, listed so the v1 boundary is in one place:

- **M9g** — project notes the user writes, read from `AGENTS.md` / `CLAUDE.md`.
- **M10** — voice input. Designed, not built.
- **M12** — Tutor Mode. Depends on everything above it.

**M8h is no longer listed here.** Resolved 20 Aug — chat and agent get no spend guard, by
design, rather than one deferred to a later milestone. Nothing left to build.

---

# Known bugs still needing fixing

*Observed defects in current behaviour — Clarvis does something wrong, not merely less than
it could. Each is triaged off the release bar deliberately: nothing here loses what the
user said, acts against a decision, or leaks internals, which is what keeps it off
`plan.md` §7's blocking checklist. If one of these turns out to cross that line on
re-reading, it moves to the bar, not here.*

## ~~Deferred: `NO-PLAN-NEEDED` reaching a throwaway project (F4)~~ — CLOSED 19 Aug

Deferred on a bet: that the analysis suppressed the verdict because the *interview*
manufactured findings for it to trip over, and that M9h part 4 would remove them. The bet
was to re-walk before touching `analysisPrompt.ts`.

**It paid.** Two independent walks after part 4 landed, two correct verdicts, and
`analysisPrompt.ts` was never opened. The analysis had never been broken.

Kept here rather than deleted, because the reasoning is the reusable part: **when a symptom
has a plausible upstream cause, fix the cause and re-measure before touching the thing that
reported it.** Two fixes aimed at one cause is how this branch got into that state to begin
with.

## Deferred: plan vocabulary on a path that has no plan

**What:** the no-plan handoff task still says *"run each check above"* when no checks were
written, *"Do not build past milestone 1"* where there is no milestone 2, and it recorded
`Comments: nope` from an answer that does not name a comment style.

**Why deferred:** none of it misled the agent — it wrote the script, ran it, and stopped
where it should. Cosmetic against a working outcome.

**One of the three is not cosmetic and belongs to M9h**: accepting "nope" as a comment style
is the narrowed challenge working exactly as written — the answer is *usable*, it just does
not answer the question. Whether an answer that does not answer should still be accepted is
an inference question, not a challenge one.

## Deferred: the character has a capability floor, and nothing says so (F18, F19)

**What:** the same eleven `voiceCheck` scenes through Llama 3.1 8B and Haiku 4.5, 20 Aug.
The prompt produces the character on a capable model and a helpdesk on a small one. The
`conversation, not a task` scene reproduced, nearly word for word, the live failure its own
`looksFor` was written to catch — sincere paragraphs with a jab stapled on.

**F19 is now partly enforced in code rather than asked for in a prompt** — see
`grounded.ts` and the note in `plan.md` §7. What follows is the finding as observed, and
the part that remains open.

Worse, and the reason this is not merely cosmetic: the small model **invented figures the
prompt forbids it to invent.** Given only *"probe-build-fail (exit 1), 40 minutes ago"* it
produced *"failed for the 40th time"*, turning a duration into a tally.
`ONLY_WHAT_YOU_WERE_GIVEN` holds on a capable model and dissolves on a small one. A flat
butler is disappointing; a butler who states a confident wrong number about your build is
one you cannot trust about anything, and §9 is almost entirely about trust.

**Why deferred:** it is not a defect in any line of code — the prompt is right, the model is
small. And **it must not be fixed by rewriting the character**: §2.1's warning is precisely
this, that a prompt tuned against a weak model's output sounds like a prompt on a strong one.

**The lever is saying which models carry the voice**, which is M8j's tiering — now on its
**third caller**, alongside F14's deadlines and F16's step budgets. Three independent
findings all wanting the same mechanism is the argument for building it.

**F26 (20 Aug) is the sharpest evidence yet, and it answers "what does the floor cost?"**
Told about a YouTube video, a 2B model invented a career for the band in it — *"a well-known
duo… featured on shows like 'Can You Feel My Heart'… performed at major festivals"* — with
the song title re-described as a television show. `grounded.ts` cannot catch it: every claim
is non-numeric, there are no given facts to check it against because the subject is the
world rather than the project, and it ran on `AgentRunner`'s narration, which the guard does
not cover. **So the cost of the capability floor is the user being told a confident
falsehood about the real world, in his voice.** In the same session, insulted by the user,
the same model dropped the character entirely for *"I am an AI assistant designed to be
helpful and harmless"* and refused a request nobody had made — the opposite failure, and
the same cause.

**The nearer half, and it is nearly free:** the manual now actively helps someone choose an
8B, and says nothing about what they lose. One honest paragraph — a small model answers
questions perfectly well and will sound less like him, and may state a number it invented —
is worth more than any prompt change, and can ship before the tiering does.

## Deferred: every question gets a tool loop, whenever the model can (F16, F17)

**What:** `Replier.withModel()` sends a question to the read-only agent loop on one
condition — `supportsTools('chat')`. Capability, never need. Chat mode means *answer and
read only*, which is about writes rather than tools, so a tool-capable model gets a loop
for every question including "how are you?".

**Observed 20 Aug**, on a local model: a greeting produced an invented `src/main.go` in an
empty folder and two `listFiles` calls malformed the same way, the second after being told
what was wrong with the first. Fifty-seven seconds for a pleasantry.

**Why deferred:** nothing is lost, nothing is done against the user's wishes, and no
internals leak. A frontier model simply answers without opening a tool — the comment in the
code explains the intent and it is sound for *"why is this test failing?"*. This is a cost
and latency problem that appears only on weaker models, which makes it **F14's family:
local reality differs and nothing in the product knows it.**

**Three shapes, in increasing cost:**

- **Let `localAnswer.ts` have first refusal.** It already answers some questions with no
  model at all; a greeting is not in its intent list and arguably could be. Cheapest, and it
  makes the answer instant rather than merely toolless.
- **A smaller step budget when the question carries no project noun** — bounds the damage
  without having to classify correctly.
- **Let M8j carry it**: a weak model gets fewer steps for a question, the same way it gets
  longer deadlines.

**F17 is not a defect and is filed here as evidence, not work.** The tool layer refused both
malformed calls, named the actual problem in plain words, and wrote nothing — the failure
was contained exactly as designed. It was simply not *learned from*, and a model that
repeats a rejected call verbatim will do so until the step cap. It is the material session 4
exists to gather, and it argues that *"is the local agent path good enough to offer?"*
depends on which model in a way the product currently says nothing about.

## Deferred: weak tool-loop persistence — one tool call, then it gives up (F21)

**What:** asked the 8B model a question needing real history (*"how long has the build
been failing, and how many times?"*). It called `gitStatus` once, got nothing relevant to
a history question, and stopped — reasoning in prose instead of reaching for `gitLog` or a
diagnostics read. Honest (no invented number, unlike F19), but useless: the loop ended one
step short of answerable. It also appended an unprompted, unrelated suggestion to rename
the current branch.

**Why deferred:** nothing lost, nothing done against the user's wishes, no internals leak
— the model refused to invent rather than inventing. **Same family as F16/F17: local
reality differs and nothing in the product knows it**, but the opposite failure shape —
F16 is the loop firing when it shouldn't, F17 is the loop repeating a rejected call, F21 is
the loop stopping *before* it should. One data point; no fix proposed. Worth another
occurrence before deciding whether this is **M8j's fourth caller** (a weak model needs more
steps *and* a nudge to try a second tool, not just fewer steps) or a prompt-level fix (tell
the model plainly when one tool wasn't enough to answer).

---

## Not deferred — where the blockers actually live

Kept as a pointer so this file cannot be read as "everything outstanding is optional".

**The list is [`plan.md`](../plan.md) §7, M11 — the v1 release bar, and it is not repeated
here.** An earlier version of this section copied it, and the copy had already drifted
within a day: it still named a blocker that was fixed and did not know about one that had
been found. That is the same failure this file's own preamble warns about, committed in the
file that warns about it.

Every finding is cross-checked against both documents by `check-findings.mjs` in the
`clarvis-firstrun` repository — run it before trusting either list.
