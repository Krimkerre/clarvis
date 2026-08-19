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

## Deferred: `NO-PLAN-NEEDED` reaching a throwaway project (F4)

**What:** a thirty-line script should be told it does not need a plan. Walked twice on 19
Aug on its designed input; produced three milestones both times.

**Why deferred:** the cause is largely upstream. The analysis suppresses the verdict because
the interview manufactures findings for it to trip over, and M9h part 4 removes much of
that. **Re-walk `3-compliment` after part 4 lands before touching `analysisPrompt.ts`** —
this may resolve without a change, and two fixes aimed at one cause is how the branch got
this way.

Ceremony for a small project is a bad experience, not a broken one. It ships.

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

## Not deferred — these are v1 blockers

Kept here as a pointer so this file cannot be read as "everything outstanding is optional".
The live list is **`plan.md` §7, M11 — the v1 release bar**:

- **F3** — a question asked back during the interview is consumed as an answer.
- **F5** — a rejected finding is recorded and the plan does the rejected thing anyway.
- **M8i part 1** — reasoning blocks leaking into the transcript and the spoken output.
- **M8h** — resolve the two settings the spec promises and the product does not have.
- **M9h part 4** — the `challengeAnswer()` narrowing described above.
- Runbook sessions 1–5 walked, with findings written down.
