# Local models for Clarvis — a measured comparison

*Run 20 Aug 2026 on one machine, against one build. Written so someone else can disagree
with the conclusions on the data rather than take my word — and so they can re-run it.
The method section says what it measures and, more usefully, what it got wrong first.*

**The harness lives in the `clarvis-firstrun` repository** (`suite2.py`, `score.py`,
`screen.py`) alongside the verification runbook, because it is testing apparatus rather
than product code. This file is the canonical write-up; that repository points here rather
than keeping a second copy, since a duplicated document in this project has already drifted
within a day once.

---

## The machine

| | |
|---|---|
| Model | MacBook Air, Apple M5, 10 cores (4 performance / 6 efficiency) |
| Memory | 24 GB unified |
| OS | macOS 27.0 |
| LM Studio | 0.4.21+2 |
| Runtime | `mlx-llm-mac-arm64-apple-metal-advsimd-1.11.0` |

**It is fanless.** That matters more than the core count. Sustained inference on a
MacBook Air throttles, and a model that finishes quickly is worth more than one with a
better score that grinds. Anything recommended here is chosen partly on that basis.

**The real memory budget is about 14 GB, not 24.** Measured with an ordinary working set
open — VS Code, a browser, LM Studio itself — the system sat around 7.6 GB before any
model loaded. Everything below assumes both a chat model and a coding model resident at
once, because that is the setup Clarvis is built for.

---

## What Clarvis actually asks of a model

This is the part that makes the benchmark specific rather than generic, and it is not
obvious from the outside.

**There are two roles, and they are lopsided.** From `AgentRunner.ts`:

```ts
const role = options.readOnly ? 'chat' : 'agent';
```

The **agent** role does exactly one thing: builds that write files. The **chat** role
carries everything else — the character, the briefing, the whole planning interview, gap
analysis, milestone planning, the post-milestone code read-back, intent routing, quips,
and the read-only tool loop that answers questions. "Chat" sounds like the decorative
role and is in fact where most of the intelligence is spent.

**Deadlines apply to the chat role only**, and they are short:

| caller | deadline | reads until |
|---|---|---|
| `Voice.say` (rewriting a written line) | 2 s | 300 chars |
| `Voice.open` (writing a line for the moment) | 5 s | 300 chars |
| `LiveQuips` | 4 s | 400 chars |
| `intentModel` (question or job?) | 2.5 s | 40 chars |
| `BriefingService` | 12 s | — |

Miss them and nothing breaks: the written fallback line is used instead. The cost is that
the character quietly becomes a static bank, which is the product's whole thesis switching
itself off (finding F14).

**The agent role has no deadline** — a build takes as long as it takes. What it needs
instead is **tool calls that are well formed, repeatedly**.

---

## Method

Every model is loaded alone with `--parallel 1`, warmed twice, then run through five
scenes three times each. Reported figures are medians.

### Speed: time-to-cap, not total generation

Every timed caller stops reading at a character cap rather than waiting for the model to
finish. So the question is never "how fast does it generate" but **"how long until it has
produced the 300 characters `Voice` will actually read?"** A verbose model is not
penalised for verbosity nobody waits for; it is penalised for being slow to the cap.

Time to first *visible* token is reported separately, because it is the number that
exposes reasoning-heavy models — see the instrument bugs below.

### Accuracy: four measures, all executed rather than eyeballed

| measure | how |
|---|---|
| **code** | The generated `dedupe(items)` is **run** against six cases chosen to break wrong answers |
| **fib** | `fib(n)` run against six cases, `fib(0) == 0` — the off-by-one trap |
| **tools** | Well-formed tool calls out of 3 attempts |
| **follow-up** | A two-turn exchange: the model asks for a file, gets a real error back, and we classify what it does next |
| **grounding** | The briefing reply is scored by **Clarvis's own `ungroundedClaims()`** — the F19 guard, comparing (value, noun) pairs |
| **brevity** | Sentence count against a prompt that says "ONE short sentence" (F20's failure) |

**The follow-up test is the one that matters most**, and no single-shot codegen test can
see it. Finding F17 was not a model that could not write Python. It was a model that
malformed a path, was told plainly *"`src/main.go` isn't there… use listFiles to see what
is"*, and then reissued the identical call **four times**. The test replays that exact
exchange and classifies the second turn:

- `used-result` — acted on what came back (correct)
- `retried` — reissued the same dead call (**F17's exact signature**)
- `gave-up` / `no-call` — stopped without using the tool

---

## Two instrument bugs, found and fixed before trusting any of this

Recorded because a benchmark nobody has tested is just a confident opinion with numbers
attached, and both of these produced *plausible* results.

**1 · The first harness measured total generation, and libelled a model.** `gpt-oss-20b`
scored "0.2 tok/s, output `<|start|>`" and looked broken. It was not: it emits a long
preamble before visible content, and an 80-token cap truncated it mid-preamble. Given
room it answers correctly — and *then* the honest number turned out to be **27 seconds to
first visible token**, which is disqualifying for a different reason. Right verdict,
wrong evidence, nearly published.

**2 · The code scorer passed an implementation that destroys order.** `list(set(items))`
scored **6/6**. The cases were all pre-sorted small integers, and small ints hash to
themselves, so `set()` iteration came out sorted by luck. Verified against known-bad
implementations and rewritten:

| implementation | before | after |
|---|---|---|
| correct (order preserving) | 6/6 | 6/6 |
| `list(set(items))` | **6/6** ❌ | 4/6 ✅ |
| `sorted(set(items))` | **6/6** ❌ | 3/6 ✅ |

---

## Screening: two checks worth doing before downloading anything

Both learned the expensive way, both free, both from `tokenizer_config.json`.

**1 · Does the chat template have a `tool_call` path?** A template can accept `tools` and
have no trained way to *emit* a call. `LFM2-24B-A2B` — a 24B mixture-of-experts with only
2B active, which looked ideal for a fanless machine — has exactly that shape. It would
have been 13.4 GB downloaded for a model that cannot drive the agent loop.

**2 · Does it carry `<think>` markers?** Reasoning models are a distinct failure here, and
which failure depends on an LM Studio setting (finding F29). Skipping them is cheaper than
diagnosing them.

Applied to a batch of candidates:

| model | GB | `tool_call` | reasoning | verdict |
|---|---|---|---|---|
| `Qwen2.5-Coder-7B-Instruct-4bit` | 4.3 | ✅ | — | screened in |
| `Ministral-8B-Instruct-2410-4bit` | 4.5 | ✅ | — | screened in |
| `Qwen2.5-Coder-14B-Instruct-MLX-4bit` | 8.3 | ✅ | — | screened in |
| `Devstral-Small-2505` | 13.3 | ❌ | — | **no tool_call**, despite being sold as an agent model |
| `gemma-3-12b-it-4bit` | 8.1 | ❌ | — | no tool_call |
| `Codestral-22B-v0.1-4bit` | 12.5 | ❌ | — | no tool_call |
| `LFM2-24B-A2B-MLX-4bit` | 13.4 | ❌ | — | no tool_call (MoE, otherwise ideal) |
| `LFM2.5-2.6B-MLX-4bit` | 1.5 | ✅ | `<think>` | screened in, with a caveat |

**Three models marketed for coding cannot drive an agent loop.** That is the single most
useful thing on this page for anyone choosing a local coding model.

---

## Results

All timings are **seconds to first visible token**, median of three runs, model loaded
alone with `--parallel 1`. Every model was also given a two-turn tool exchange and two
executed coding tasks.

| model | GB | first token | tools | follow-up | dedupe | fib |
|---|---:|---:|:---:|---|:---:|:---:|
| `qwen3.5-2b-mlx` | 1.8 | **0.22** | 3/3 | used-result | 6/6 | 6/6 |
| `phi-4-mini-instruct` | 2.2 | 0.26 | 3/3 | used-result | 6/6 | 6/6 |
| `qwen2.5-coder-7b-instruct` | 4.3 | 0.26 | 3/3 | used-result | 6/6 | 6/6 |
| `ministral-8b-instruct-2410` | 4.5 | 0.26 | 3/3 | used-result | 6/6 | 6/6 |
| `qwen/qwen3-4b-2507` | 2.3 | 0.38 | 3/3 | used-result | 6/6 | 6/6 |
| `meta-llama-3.1-8b-instruct` | 4.5 | 0.48 | 3/3 | used-result | 6/6 | 6/6 |
| `qwen2.5-coder-14b-instruct-mlx` | 8.3 | 0.80 | 3/3 | used-result | 6/6 | 6/6 |
| `lfm2.5-2.6b-mlx` | 1.5 | **5.50** | 3/3 | used-result | 6/6 | ✗ no function |

**Every model except one clears every deadline with room to spare.** The tightest is
`Voice.say` at 2s; the slowest qualifying model reaches first token in 0.8s.

### Generation speed, in real tokens per second

Counted from the server's own `usage.completion_tokens` (via `stream_options.include_usage`),
not estimated from characters. Median of three, ~150-word prose task.

| model | GB | tok/s generating | tok/s effective | TTFT |
|---|---:|---:|---:|---:|
| `qwen3.5-2b-mlx` | 1.8 | **93.6** | 88.2 | 0.14 |
| `phi-4-mini-instruct` | 2.2 | 48.8 | 47.6 | 0.20 |
| `qwen/qwen3-4b-2507` | 2.3 | 46.5 | 44.7 | 0.16 |
| `qwen2.5-coder-7b-instruct` | 4.3 | 29.5 | 27.0 | 0.22 |
| `ministral-8b-instruct-2410` | 4.5 | 25.3 | 24.4 | 0.22 |
| `meta-llama-3.1-8b-instruct` | 4.5 | 19.9 | 19.3 | 0.23 |
| `qwen2.5-coder-14b-instruct-mlx` | 8.3 | **9.6** | 9.2 | 0.62 |
| `lfm2.5-2.6b-mlx` | 1.5 | — | — | no visible output |

**Two rates, because conflating them is how a benchmark recommends an unusable model.**
*Generating* is the sustained rate once the model is talking — the number people mean by
"tok/s". *Effective* counts from the request being sent, so it includes prompt processing
and any preamble emitted before visible content.

For every model here the two are within ~5% of each other, which is itself the finding:
none of them front-load. **`gpt-oss-20b` is why the distinction exists** — a perfectly
healthy generation rate and **27 seconds** before its first visible character. A table
reporting only the first column would have recommended it.

**Rate falls off roughly with size, and the fall is steep.** `qwen2.5-coder-7b` generates
**three times faster** than the 14B (29.5 vs 9.6) while scoring identically on every
accuracy measure in this document. That is the single strongest argument for the
recommendation below, and it was invisible until tokens were counted — the two models look
similar on time-to-first-token (0.22s vs 0.62s), because that measures how quickly they
*start*, not how quickly they finish.

**A caveat on the headline number.** `qwen3.5-2b` at 93.6 tok/s is the fastest thing here
and is a `vlm`-typed model that has produced invented facts in earlier scenes. Speed is not
the whole ranking; see the accuracy section.

### Co-resident (both models loaded at once)

| pairing | GB | first token A | first token B | notes |
|---|---:|---:|---:|---|
| `phi-4-mini` + `coder-7b` | 6.5 | 0.30 | 0.69 | no meaningful contention |
| `coder-7b` + `ministral-8b` | 8.8 | 0.34 | 0.49 | ministral's follow-up degraded to **no-call** |
| `lfm2.5-2.6b` + `coder-14b` | 9.9 | 4.50 | 1.39 | lfm2.5 briefing hit **11.1s** |
| `ministral-8b` + `coder-14b` | 12.9 | 0.43 | 0.77 | ministral's follow-up degraded to **gave-up** |

**Holding two models costs almost nothing on 24 GB**, up to 12.9 GB resident. The
first-token penalty is a few hundred milliseconds and every pairing still clears the
deadlines. This is the finding that makes the two-model setup worth having.

*An earlier draft added "provided `unloadPreviousJITModelOnLoad` is off". **That was wrong
and is withdrawn** — see F28. Tested directly: three models stayed resident at once, two of
them auto-loaded, with that setting on. LM Studio hosts several models without evicting
anything. What is real is the **cold-load stall**: the first request to a model that is not
resident takes ~5.3s, past the 5s opening deadline, which is a warm-up problem and is what
`lmStudioTune.ts` addresses.*

### Three tests that did not discriminate, and one that did

**Code correctness was 6/6 everywhere.** Both tasks, every model, including the 1.8 GB
one. At this size class basic code generation is *solved*; it is not a useful axis for
choosing between these models, and the honest thing is to say so rather than present eight
identical scores as a result. The only miss was `lfm2.5-2.6b` failing to emit a usable
`fib` at all.

**Tool-call reliability was 3/3 everywhere.** Also not discriminating — but worth
recording, because it means the screening step did its job: every model that reached this
table had already been filtered for a `tool_call` path in its chat template.

**The multi-turn follow-up did discriminate, and only under co-residency.**
`ministral-8b` handled it correctly when alone and failed it in **both** dual pairings —
`no-call` once, `gave-up` once. That is a real mark against it for the agent role, and
nothing in the single-model table would have shown it.

---

## What the automated scoring missed

**`ungroundedClaims()` reported "clean" for every model, and reading the replies shows
that is wrong.** Three inventions the check did not catch:

| model | said | given |
|---|---|---|
| `qwen/qwen3-4b-2507` | *"verify your syntax and ensure the `main.js` file isn't attempting to parse a non-existent `unicorn`"* | no file, no syntax error |
| `meta-llama-3.1-8b` | *"The branch is **one commit ahead** of…"* | nothing about being ahead |
| `qwen3.5-2b` | *"The clean tree state is **restored**"* / *"I have no choice but to close the editor"* | nothing restored, no such action |

**Why the guard missed them, and it is not a bug.** `grounded.ts` compares `(value, noun)`
pairs — it catches *numbers* the given facts cannot account for. Two of these inventions
are entirely non-numeric, which is F26's territory and explicitly outside what the guard
claims to do. The third — *"one commit ahead"* — is numeric and still missed, because
**`one` and `first` were deliberately excluded from the number table** when F19's guard
produced a false positive on *"one of settings.json, plan.md or app.js"*. That trade was
made knowingly and written down; this is the first time its cost has been visible.

**The lesson for anyone using this file:** the automated column says *no invented numbers*,
not *nothing invented*. A human still has to read the replies. That is exactly why
`voiceCheck` produces a report a person reads rather than a pass/fail.

---

## Rejected, and why — so nobody re-tries them

| model | GB | why |
|---|---:|---|
| `lfm2.5-2.6b` | 1.5 | **5.5s to first token alone, 11.1s co-resident.** Carries `<think>` markers; it thinks before speaking. Blows the 2s and 5s deadlines every time |
| `ornith-1.0-9b` | 6.0 | Reasoning model. **40+ seconds per scene to produce nothing visible** (F29) |
| `qwen/qwen3.5-9b` | 6.0 | Reasoning model. Empty `content` across four scenes |
| `gpt-oss-20b` | 12.1 | **27s to first visible token.** Emits a long preamble before content |
| `qwen3.5-4b-optiq` | 4.0 | **Fails to load** — vision weights the MLX runtime rejects |
| `qwen3.5-9b-optiq` | 8.2 | **Fails to load** — same |
| `prism-ml/bonsai-27b` | 8.5 | 2-bit quantisation; missed the personality deadlines (this was F14's origin) |
| `gemma-4-12b-coder` | 6.7 | Works, but leaks a `<turn\|>` template token into output and loses to a smaller model |
| `LFM2-24B-A2B` | 13.4 | Never downloaded — **no `tool_call` path** in its chat template. A 24B MoE with 2B active, otherwise ideal for a fanless machine |
| `Devstral-Small-2505` | 13.3 | Never downloaded — no `tool_call` path, despite being sold as a coding agent model |
| `Codestral-22B` | 12.5 | Never downloaded — no `tool_call` path |
| `gemma-3-12b-it` | 8.1 | Never downloaded — no `tool_call` path |

**The last four cost nothing to reject.** The screening step is the highest-value part of
this exercise: four models, 47 GB of downloads avoided, from reading a JSON file.

---

## Recommendation

**One model, both roles: `qwen2.5-coder-7b-instruct` — 4.3 GB.**

It wins or ties on everything measurable: 0.26s to first token, **29.5 tok/s — three times
the 14B's rate**, 3/3 tool calls, correct follow-up behaviour, 6/6 on both coding tasks, no
invented facts in its briefing, and a one-sentence quip that stays one sentence. At 4.3 GB
it leaves roughly 19 GB of a 24 GB machine alone and needs no second model.

**The token-rate measurement is what settles it against the 14B.** They look close on
time-to-first-token (0.22s vs 0.62s) and score identically on accuracy — but that measures
how fast each *starts*, and the 14B generates at 9.6 tok/s against the 7B's 29.5. On a
long answer that is the difference between four seconds and twelve.

**If you want two:** add `meta-llama-3.1-8b-instruct` (4.5 GB) on chat, which produced the
closest thing to the character in this whole run — *"Your build has once again failed,
sir."* Total 8.8 GB. Be aware it invented "one commit ahead" in the briefing, which is the
trade you are making for tone.

**Do not put `ministral-8b` on the agent role.** It looks excellent alone and failed the
tool follow-up in both co-resident pairings.

**On character, the honest answer is that none of them have it.** Read the quips: the
best is passable and most are a helpdesk. `phi-4-mini` opened a briefing with *"Good
day!"* and refused an earlier one as academic dishonesty. This is finding **F18** — the
character prompt has a capability floor, and every model here is under it. **The fix is
not to rewrite the character** (§2.1: a prompt tuned against a weak model's output sounds
wrong on a strong one). If the voice matters more than privacy or cost, that is the
argument for a hosted model on the chat role — see the combinations discussion in
`FINDINGS.md`.

---

## Re-running this yourself

```bash
python3 suite2.py single <model-id> [<model-id> ...]   # each alone
python3 suite2.py dual <model-a> <model-b>             # both resident
python3 score.py n_*.json                              # accuracy scoring
```

`score.py` shells out to Clarvis's compiled `out/personality/grounded.js`, so run
`npm run test` (or `tsc --outDir out`) in the `clarvis` repository first.

**Timings are machine-specific and quantisation-specific.** The *rankings* should travel;
the absolute numbers will not. The screening table travels regardless — a chat template
either has a `tool_call` path or it does not, on any machine.
