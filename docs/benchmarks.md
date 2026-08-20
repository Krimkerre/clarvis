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

> **Rewritten 20 Aug (late), and the results below predate it.** `screen.py` matched marker
> strings in a chat template; it now *renders* the template with Jinja and reads the output,
> and validates itself against models whose behaviour was established by running them (F32).
> Two consequences for the table that follows. **A verdict belongs to a build, not a model** —
> `LFM2-24B-A2B` renders a tool call upstream and cannot in its LM Studio repack, so the
> rejection below is right about the build and wrong in its stated reason. And **a tool path
> is not proof of working tools**: `granite-4.0-h-tiny` renders a perfect one and is still
> unusable on the MLX runtime (F30).

Both learned the expensive way, both free — and **the screen itself was wrong twice before
it was right**, which is recorded below because a screening table nobody has tested is the
most dangerous kind of confident artifact.

**1 · Does the chat template have a tool-call path?** A template can accept `tools` and have
no trained way to *emit* a call. `LFM2-24B-A2B` — a 24B mixture-of-experts with 2B active,
which looked ideal for a fanless machine — has exactly that shape.

**2 · Does it carry `<think>` markers?** Reasoning models fail differently here, and which
failure you get depends on an LM Studio setting (F29).

**But `<think>` is not automatically disqualifying**, and an earlier version of this
document treated it as if it were. Qwen3, GLM and Hunyuan all support turning thinking off
(`enable_thinking: false`, or `/no_think` in the prompt — which is what `plan.md`'s M8i
part 2 is about). So a `THINKS` verdict means *"needs thinking disabled before it is
usable"*, not *"unusable"*. Whether that switch works on a given model is a live question,
not a settled one.

### Screening results

| model | GB | arch | tools | reasoning | verdict |
|---|---:|---|:---:|---|---|
| `Qwen2.5-Coder-7B-Instruct` | 4.3 | qwen2 | ✅ | — | **usable** |
| `Ministral-8B-Instruct-2410` | 4.5 | mistral | ✅ | — | **usable** |
| `Qwen2.5-Coder-14B-Instruct` | 8.3 | qwen2 | ✅ | — | **usable** |
| `Qwen3-Coder-30B-A3B-Instruct` | 17.2 / 13.4 (3-bit) | qwen3_moe | ✅ | — | usable, **does not fit at 4-bit** |
| `LFM2.5-2.6B` | 1.5 | lfm2 | ✅ | `<think>` | needs thinking off |
| `Hunyuan-4B-Instruct` | 2.4 | hunyuan | ✅ | `<think>` | needs thinking off |
| `gpt-oss-20b` | 12.1 | gpt_oss | ✅ | thinking | needs thinking off — **explains its 27s** |
| `GLM-4.7-Flash` | 16.9 | glm4_moe | ✅ | `<think>` | needs thinking off; too big |
| `NVIDIA-Nemotron-3.5-Lightning-30B-A3B` | 17.8 | nemotron_h | ✅ | `<think>` | needs thinking off; too big |
| `GLM-4.5-Air` | 46.8 | glm4_moe | ✅ | `<think>` | far too big |
| `Codestral-22B` | 12.5 | mistral | ❌ | — | no tool path |
| `gemma-3-12b-it` | 8.1 | gemma3 | ❌ | — | no tool path |
| `Devstral-Small-2505` | 13.3 | mistral | ❌ | — | no tool path, **despite being sold as an agent model** |
| `ERNIE-4.5-21B-A3B` | 12.3 | ernie4_5_moe | ❌ | — | no tool path |
| `Phi-3.5-MoE-instruct` | 23.6 | phimoe | ❌ | — | no tool path |
| `LFM2-24B-A2B` | 13.4 | lfm2_moe | ❌ | thinking | no tool path (MoE, otherwise ideal) |

**Six models sold or assumed usable for coding have no tool-call path at all** — Codestral,
Devstral, gemma-3-12b, ERNIE, Phi-3.5-MoE, LFM2-24B. They can write code and cannot drive an
agent loop. That is the single most useful line on this page, and it costs nothing to check.

### On mixture-of-experts, since it looks like the obvious answer for a fanless machine

**All weights must be resident; only a slice is computed.** `Qwen3-Coder-30B-A3B` has 128
experts and activates 8 per token, and the router picks a different 8 each time — so all
17.2 GB has to be in memory, while roughly 3B parameters do the arithmetic. **MoE buys speed
and heat, not memory.** That is the reverse of what it looks like, and it is why the 30B
does not fit here despite behaving like a 3B.

*(LM Studio does expose `numCpuExpertLayersRatio` — expert offloading to CPU — which trades
away exactly the speed MoE is bought for.)*

**A pattern worth knowing before hunting:** among non-Qwen MoE models in this size range,
**every one with a tool-call path is a reasoning model**, and the two that are not have no
tool path. That is a fact about what has been published, not a preference.

***Withdrawn 20 Aug (late).*** `granite-4.0-h-tiny` — IBM, 3.9 GB, `granitemoehybrid`, 64
experts with 6 active — has a tool path, no reasoning, and is the fastest model in this
document. It was missed because nothing had screened IBM's line. `LFM2.5-8B-A1B` (4.8 GB)
is a second counter-example. The sentence was true of the models that had been looked at,
which is not the same thing.

### The screen was wrong twice — both bugs are instructive

**1 · It read only `tokenizer_config.json`.** Newer repositories put the chat template in a
separate `chat_template.jinja`, so the screen saw an empty template and reported *no tool
support* for **`Qwen3-Coder-30B-A3B`** — a model built for agentic tool use. Caught only
because the result was too implausible to accept. It now reads both files and takes
whichever has content. Every earlier rejection was re-run against the fixed screen: all of
them held except the two Qwen3 MoE entries.

**2 · It matched only the literal string `tool_call`.** Templates use several shapes
(`tool_calls`, `<tools>`, `tool_response`), so the marker set is now wider.

**The lesson, since this is the third instrument bug in this document:** a screen that has
never been run against a known-good *and* a known-bad example is a guess with a table around
it. Both fixes came from a result that looked wrong, not from a test — which is luck, and
the reason every verdict above was re-run rather than trusted.

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
| `LFM2-24B-A2B` | 13.4 | Never downloaded — **no tool-call path**. A 24B MoE with 2B active, otherwise ideal for a fanless machine |
| `Devstral-Small-2505` | 13.3 | Never downloaded — no tool-call path, despite being sold as a coding agent model |
| `Codestral-22B` | 12.5 | Never downloaded — no tool-call path |
| `gemma-3-12b-it` | 8.1 | Never downloaded — no tool-call path |
| `ERNIE-4.5-21B-A3B` | 12.3 | Never downloaded — no tool-call path |
| `Phi-3.5-MoE-instruct` | 23.6 | Never downloaded — no tool-call path, and too big |
| `Qwen3-Coder-30B-A3B` | 17.2 | **Not rejected on merit — it does not fit.** Full tool support, non-reasoning, MoE with 3B active. 17.2 GB + ~7.6 GB of system is 24.8 GB on a 24 GB machine. Only the 3-bit build (13.4 GB) fits, and 3-bit costs enough quality that it is not clearly better than a 7B at 4-bit. **Untested** |

**Rejecting on the screen cost nothing.** Six models, well over 80 GB of downloads avoided,
from reading one file per repository — **once the screen was reading the right files.** See
the two bugs above; four of these six were re-verified after the fix rather than left on the
original verdict.

---

## Late on 20 Aug: granite, and what it cost to find out

Run after everything above, with `qwen2.5-coder-7b-instruct` re-measured the same evening as
a control — the machine is fanless and a table measured on another day flatters or punishes
for reasons that are not the model. The control reproduced itself (29.5 → 28.5 tok/s), so
these rows are comparable.

| build | GB | tok/s | TTFT | tools (8 phrasings, streamed) | recovery |
|---|---:|---:|---:|:---:|---|
| `granite-4.0-h-tiny` · **GGUF**, llama.cpp | 4.2 | **55.2** | **0.06** | **8/8** | used-result |
| `granite-4.0-h-tiny` · MLX | 3.9 | **94.5** | 0.13 | **1/8**, 7 arguments lost | never reached |
| `qwen2.5-coder-7b-instruct` (control) | 4.3 | 28.5 | 0.24 | 8/8 | used-result |

**The same model, two packagings, opposite outcomes** — the MLX runtime's parser discards
its tool calls (F30). On GGUF it is usable and roughly twice the control's rate; on MLX it is
fast and cannot ask for a file.

**Co-resident, granite (MLX) + `qwen2.5-coder-7b`, 8.2 GB:** neither degraded. Granite reached
a full 300-character spoken line in **0.65s** against the control's **2.43s**, and the
control kept its `used-result` recovery — which `ministral-8b` did not, when it shared memory.
Even with its tools broken, granite is a candidate for the *talking* role, which never calls
a tool.

**Screened, not downloaded** (with the rewritten screen, against the exact builds):

| build | GB | MoE | tools | thinking |
|---|---:|---|:---:|---|
| `LFM2.5-8B-A1B-MLX-4bit` | 4.8 | 4/tok | yes | none in template |
| `Ministral-3-8B-Instruct-2512-4bit` | 5.6 | — | yes | none |
| `gemma-4-E4B-it-MLX-4bit` | 6.9 | — | yes | optional |
| `Qwen3.8-27B-MLX-4bit` | 16.1 | — | yes | over budget |
| `Qwen3.6-35B-A3B-4bit` | 20.4 | 3/tok | yes | over budget |

**Every earlier rejection was re-checked per build — all six hold.** `LFM2-24B-A2B`,
`Devstral`, `ERNIE`, `Phi-3.5-MoE`, `Codestral` and `gemma-3-12b` gained nothing in either
packaging. LFM2-24B's repacks (MLX *and* GGUF) ship the same stripped template, so that
rejection is right about the build and wrong about the model (F33).

**A rejection also belongs to a role.** `lfm2.5-2.6b` is a forced-reasoning model — its
template opens a thinking block unconditionally, so no switch turns it off, and on the chat
path it produced **zero visible characters in 8.7 seconds**. On the agent path, which has no
deadline, the same build makes 8/8 well-formed calls, recovers from a bad path, and finishes
a two-file editing job with a written summary — inconsistently, 4 runs of 7, looping on
absolute paths when it fails, and slower as the fanless machine heats. Not a recommendation;
the point is that one list was judging two different jobs (F34). `agentrole.js` measures the
second.

**Two corrections to earlier rejections.** `gemma-4` has a tool path where `gemma-3` had
none, so that family is worth revisiting. And **Qwen3.8 has no small MoE** — the generation
shipped a 27B dense model and a 2.4T-A95B one, nothing between.

**One trap, recorded because it produced a clean-looking wrong answer.** With two builds of
one model installed, the bare identifier `granite-4.0-h-tiny` is ambiguous and LM Studio
resolved it to the other build — two identical score rows that were the same model measured
twice. Compare builds by full `author/model` identifier.

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

**Open, as of late 20 Aug: `granite-4.0-h-tiny` (GGUF) may beat this.** It is twice the
rate, starts faster, gets 8/8 streamed tool calls and recovers correctly — on a sample of
eight requests and three recovery runs, against the full suite behind the recommendation
above. It has not been run through the whole benchmark, and the recommendation does not move
until it has. **Take the GGUF build; the MLX build of the same model cannot ask for a file
(F30).**

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
