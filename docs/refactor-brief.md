# Refactor brief — written 20 Aug 2026

*A cold-start prompt for a refactor pass. Point a fresh session at this file, or paste the
block below. It exists because the constraints that matter here are not guessable: this
codebase deliberately breaks one common rule, already enforces another mechanically, and
is one item away from a release bar it must not disturb.*

---

## The prompt

```
Refactor pass on Clarvis. Two repos: ~/Documents/coding/clarvis (the VS Code
extension) and ~/Documents/coding/clarvis-firstrun (verification harnesses +
findings). Work in the first; leave the second alone unless I ask.

Read in this order before proposing anything:
  1. clarvis/AGENTS.md — the working agreement, especially Plan Mode vs Code Mode
  2. clarvis/plan.md §0 — the clean-code rules this project holds itself to
  3. clarvis/docs/CURRENT_STATE.md — architecture map and what is built

THE TASK
Audit the codebase against §0's own rules and propose a refactor plan. Audit
first, read-only. I sign off before any code changes. Then refactor in small
steps with a green build on both sides of each one — §0 says never in big
batches, and that is the rule most likely to be broken here.

NON-NEGOTIABLES — these will trip you if you skim
- Comments are a DELIBERATE deviation (plan.md §0, "One deliberate deviation").
  This codebase carries explanatory prose throughout because it doubles as a
  worked example: ~8,600 of 25,000 source lines are comments, by design. Do not
  propose stripping them. A comment that only restates its line is still noise.
- eslint already enforces cyclomatic complexity <= 15, and the suite is green,
  so complexity violations do not exist. Look for what a linter cannot see:
  duplication that has already drifted, functions nobody can test without an
  extension host, flag arguments, files with more than one reason to change.
- §0 caps functions at ~20 lines ideal, 0-2 arguments (3 max), and forbids
  boolean flag arguments — split into two named functions instead.
- YAGNI. Every proposal needs a concrete payoff: a bug it would have prevented,
  a duplication that already diverged, or a unit that cannot be tested today.
  "Cleaner" on its own is not a reason. Deletion beats extraction.

VERIFY BY RUNNING IT
  npm run check       # types + lint + 1005 tests
  npm run test:host   # 4 tests in a real extension host
Both green before and after every step. This project has shipped
confidently-wrong fixes that passed review and failed on first real use;
docs/build-log.md is largely a record of that. Behaviour-preserving is a claim
that needs the suite to back it, not an assertion.

MEASURED STARTING POINTS (from a crude scan — verify before trusting)
  src/chat/ChatService.ts     1286 lines
  src/extension.ts            1026 lines, with registration functions at
                              242/239/231 lines (startBranchFlow,
                              registerPlanningCommand, setVoice)
  src/agent/AgentRunner.ts     888 lines
  src/planning/Interview.ts    878 lines
  src/model/OpenAiCompatibleProvider.ts — stream() and post() build nearly
  identical request bodies; the two stream loops were extended separately on
  20 Aug and are a live drift risk.
Subsystem sizes: agent/ 15.3k, chat/ 13.8k, planning/ 13.3k, model/ 7.3k,
personality/ 6.6k, voice/ 4.1k lines.

CONTEXT YOU SHOULD NOT REDISCOVER
The v1 release bar is 22 of 23 (plan.md §7, M11); only runbook sessions A-C
remain, and they are hands-on work I do. So this refactor must not change
behaviour — anything that does is a new scope conversation, not a refactor.

Ultracode is on: use workflows for the audit fan-out, and adversarially verify
findings before presenting them. Do not spawn agents that edit files during the
audit phase.
```

---

## Why each constraint is in there

**The comment deviation.** It is the first thing a generic refactor pass would "fix", and
it would delete the single most deliberate decision in the codebase. §0 states it plainly;
this brief repeats it because a skimmed §0 is the likely failure.

**The complexity ceiling.** `eslint.config.mjs` enforces 15, below ESLint's default of 20,
and its own header explains why the file exists at all. An audit that reports complexity
findings has not run the linter, and is reporting things that cannot be true of a green
tree.

**Behaviour-preserving.** The release bar is at 22 of 23 with only hands-on verification
left. A refactor that changes behaviour invalidates verification that has already been
walked, which costs hours of somebody's evening rather than minutes of an agent's.

**Verify by running it.** The house rule, and the one this project has paid for most. On
20 Aug alone: a benchmark that tested a mode the product never uses passed a model that
fails every realistic request; a screening script was wrong three different ways; and two
prompt fixes were reported as improvements on single runs against a **32% noise floor**.
None of those were caught by review.

## The numbers are crude on purpose

The function lengths above came from a regex scan, and it visibly mis-parses — it reported
several 250-line functions in `Interview.ts` that are almost certainly `log(` calls. The
file sizes are `wc -l` and are exact. Anything else in that list is a starting point for
measurement, not a finding.
