# Future features — what is deliberately not in v1

*Opened 19 Aug, when the goal became **a stable first release** rather than a more complete
one. This is a decision record about what is being left out and why, not a second copy of
the spec: each item points at the `plan.md` section that specifies it. If this file and
`plan.md` disagree about what something **is**, `plan.md` is right — this file only claims
when it happens.*

**The bar this file exists to protect.** v1 ships when Clarvis does not lose what you told
it, does not act against what you decided, and does not leak its own internals into your
face. Everything that makes it *better* rather than *correct* lives here.

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
deferral becomes a section in this file, naming the milestone that will specify it. Either
way, the observation itself — what happened, the log evidence, why it matters — goes in
`clarvis-firstrun/FINDINGS.md` first, while it is fresh, and is triaged from there.

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

## Deferred: provider-side reasoning control (M8i part 2)

**What:** `thinking` / `reasoning_effort` per provider. `plan.md` §7, M8i.

**Why deferred:** explicitly not approved at sign-off. One toggle cannot mean the same
thing across five providers — Qwen3's is `/no_think` in the prompt, not an API — and a
switch that silently does nothing on some models is worse than no switch. **M8i part 1
(stripping reasoning out of the transcript and the spoken output) is a v1 blocker and is
not deferred.**

## Deferred: model-family recognition (M8j)

**What:** a regex table over model ids seeding per-family defaults. `plan.md` §7, M8j.

**Why deferred:** signed off as *design constraints settled, build deferred* — its only real
customer is M9h's `shouldAsk`, and a family table with no caller is speculative
configuration. It follows M9h parts 1–3 here.

## Deferred: the milestones already marked stretch

Unchanged by this decision, listed so the v1 boundary is in one place:

- **M9g** — project notes the user writes, read from `AGENTS.md` / `CLAUDE.md`.
- **M10** — voice input. Designed, not built.
- **M12** — Tutor Mode. Depends on everything above it.
- **M8h's guard, if it is built at all** — see the release bar in M11; v1 requires the
  *spec* to stop promising controls that do not exist, not that the controls exist.

---

## Not deferred — where the blockers actually live

Kept as a pointer so this file cannot be read as "everything outstanding is optional".

**The list is [`plan.md`](../plan.md) §7, M11 — the v1 release bar, and it is not repeated
here.** An earlier version of this section copied it, and the copy had already drifted
within a day: it still named a blocker that was fixed and did not know about one that had
been found. That is the same failure this file's own preamble warns about, committed in the
file that warns about it.

Every finding is cross-checked against both documents by `check-findings.mjs` in the
runbook repository, which fails if one knows about a finding the other does not.
