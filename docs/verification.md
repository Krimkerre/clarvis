# Verification — what is still outstanding

*Split out of `plan.md` §10 on 16 Aug so the plan holds the plan. This is the list of
checks still to run by hand: the ones that need a real editor, a real provider, or a
real operating system, and so cannot be a unit test.*

**This is not the automated suite.** `npm run check` (842 tests) and
`npm run test:host` run themselves and are green; see
[`CURRENT_STATE.md`](CURRENT_STATE.md) for how to run them. Everything below is what
those two genuinely cannot cover.

**Per-milestone exit checklists stay in [`../plan.md`](../plan.md) §7**, next to the
milestone they belong to — a check written before the code exists is part of the plan
for that milestone, not a separate document.

---

Started 14 Aug as a list to *run*, not just read. Projects 1 and 2 have now run;
3 and 4 have not. **What each run found is in [`build-log.md`](build-log.md)**,
not here — the sandbox verification, the two live projects, and every defect they
turned up. This section is only what is still open: which projects are left, which
conditions to run them under, and which checklist lines are still unchecked.

### The projects, and what each one forces

Chosen so the interesting path cannot be avoided rather than merely being available.

**1. "A tool that renames my photos by the date they were taken." (Python)**
Forces: PEP 8 conventions, a `pip install` under the sandbox, and — the point — a
program whose whole job is *moving and overwriting files*. If the checkpoint or the
sandbox is wrong, this is where it shows. Big enough for three or four milestones.
Answer "somewhere on my machine" to *where does it run* to trigger the pushback.

Two sandbox defects were found and fixed before project 2 ran, by testing the profile
against a real `go build` instead of waiting to hit them live — see build-log.

**2. "A command-line tool that fetches the weather and caches it." (Rust or Go)**
Forces the build-cache allowlist, which is the sandbox's most likely real-world
break: `cargo build` writes to `~/.cargo/registry`, `go build` to `~/go/pkg`. If
those are missing from the profile the build fails under confinement and works
outside it — the exact "sandbox breaks the toolchain" failure that gets sandboxes
switched off. Also exercises the non-Python conventions lookup.

**3. "A script that prints a different compliment each time you run it."**
Forces the **no-plan-needed** outcome, which nothing else reaches — a 30-line
throwaway should be told it doesn't need a plan rather than handed four milestones of
ceremony. Also the fastest way to see whether the analysis over-produces.

Pre-tested three times before running it for real: twice it returned `NO-PLAN-NEEDED`,
once it correctly declined to, because the seed as written contains a genuine
contradiction. The outcome depends on how the interview is answered — this project
tests that the branch *exists*, not that it is inevitable.

**4. Anything at all, in Elixir, Zig or Ruby.**
Forces the honest conventions fallback: no entry exists, so the plan must say the
specifics were never written down rather than inventing four plausible idioms. The
failure to look for is confident invention.

### Conditions to run them under

Each of these changes a code path rather than a project, so pair them with any of the
above:

- **A folder with no git**, for the `git init` offer and checkpoint-only protection.
- **A folder opened as untrusted** (Restricted Mode), for `requireTrust` — commands
  and edits refused, reading and answering still working.
- **A folder that already has a `plan.md`**, for keep-or-replace being asked *before*
  the interview rather than after it.

### The loop itself, in one sitting

Never done. Each piece works alone; the seams between them are untested.

- [x] Plan → approve → build milestone one → it stops with what changed and the check
      results → offers to write them into `plan.md` — **project 2, 15 Aug.** 20 steps,
      3 files, real Go built and run against the live API.
- [x] `plan.md` is ticked correctly, results recorded beside the steps — each with the
      command's actual output, including the deliberately sabotaged host used to test
      the unreachable-server path.
- [x] The next milestone is offered, not started
- [ ] Mid-build, say "use a different library" — folded in as a correction
- [ ] Mid-build, say "it should also email me the results" — **stops**, names it as new
      scope, offers to write it into the plan first
- [x] Close the window mid-interview, reopen — offered carry on / start again / leave it
      — after the offer was moved to where someone reopening a window actually is.
- [ ] Close the window mid-build, reopen — offered to pick the milestone up
- [ ] The panel shows "Step 2 of 4" and clears when the run ends
- [ ] Auto asks before each change; Unattended does not, and says so once when chosen

### The two M9d2 items that have never run

- [x] The comment-style question is asked once, in the final round, both options
      presented as legitimate — **verified, project 1.** Asked last, pushed back once
      on a vague answer ("either works here"), and synthesised into the plan's
      Conventions section.
- [ ] Build a file under each setting — `explanatory` produces comments throughout,
      `lean` only where something is surprising

### Older debts, not to be lost

**The M6 dogfood pass is not being closed by any of this, and it is worth saying why
rather than assuming otherwise.** Measured across a full day of heavy use on 15 Aug:
of the seven unsolicited triggers, exactly **one fired, twice** —
`firstCommitAfterSilence`. `buildSlow`, `repeatFailure`, `suiteWentGreen`, `bigDiff`,
`taskDone` and `newBranch` never fired at all.

Three reasons, none of which projects 3 and 4 improve. The test projects are too small
to trip anything — `go build` on 327 lines takes two seconds against a thirty-second
threshold, no suite went red then green, no diff came near two hundred files. Agent runs
*deliberately* suppress the watch surfaces, so the day was spent with them switched off
by design. And M6's actual question — does the cadence feel right, does a line grate on
a third viewing, does earned sass fire before it is earned — needs the same lines seen
repeatedly across days of ordinary work, which is not a thing a scripted pass can
produce.

What §10 *has* exercised hard is §2.2's one-voice-everywhere: the briefing, gate copy,
findings, the read-back summary, the answer about his own capabilities. That is the
adjacent question, and confusing the two would close a debt that is still open. The M6
pass wants Clarvis watching someone work normally in a project with slow builds and real
failures — this repository being the obvious candidate.

The M6 dogfood pass has been outstanding since M6, and roughly 45 finer-grained M8
checklist items remain unverified — mute mid-sentence, avatar strobing, transcript
persistence, Ollama. Both predate M9 and neither is closed by anything above.
