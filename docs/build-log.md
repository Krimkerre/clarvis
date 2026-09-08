# Clarvis — build log

Chronological findings from building and dogfooding Clarvis, moved out of `plan.md` on
15 Aug so the specification stays the specification. `plan.md` is current truth — what
the product is and does now; this file is archaeology — what went wrong, when, and why
the fix looks the way it does.

Nothing here is normative. If this file and `plan.md` ever disagree about what the
product currently does, `plan.md` is right and this file is stale — update this file's
framing, never the reverse.

Ordered as written, oldest first.

---

#### Personality amendment — the briefing invents too, when facts run out

Found live: a folder with no git in it (the `no-repo` fixture, built for the M8 exit
checklist) produced *"Last commit was on `main` three days ago"* — a branch name,
a timeframe and a commit history, none of which exist anywhere, because there is no
repository at all.

The no-invention rule (`ONLY_WHAT_YOU_WERE_GIVEN`, §2.2) had been added to the rewrite
prompt and the quip prompts — every surface that is handed a line and nothing else. It
was never added to the briefing's own system prompt, because the briefing normally *does*
carry real facts and the gap only shows up when one of them is genuinely absent. That
made it the more convincing kind of invention: on an ordinary project the model has
enough real material that a fabricated detail blends in.

Fixed in both places that assemble that prompt — `extension.ts`'s live phraser and the
matching scene in the voice check — plus a second voice-check scene that hands the
briefing prompt no git facts at all, so the case that was actually observed is now the
one that gets checked before every future change to this prompt.

Deliberately not extended to `agentSystemPrompt()` or `Replier.systemPrompt()`. Both back
onto a live tool loop — the model can `readFile` or `gitStatus` rather than guess — which
is a materially different situation from a one-shot prompt with a fixed facts block, and
today's evidence from the agent-run paths showed grounded, tool-backed remarks rather
than invented ones. Worth revisiting only if that stops being true.

---

---

#### M5 amendment — an error has to survive to count

Diagnostics were counted the moment they appeared. There was already a twelve-second
grace after activation, on the reasoning that a language server reports pre-existing
errors late — but that covers the start of a session and nothing after it, and most of
what a language server emits is transient: a half-written line is an error until it is
finished, and reopening a project produces a burst of "Cannot find name 'process'" that
resolves itself as soon as types load.

Observed rather than predicted. A briefing opened with *"that `Type 'string' is not
assignable to type 'number'` error has shown up twice this week"* about an error that
never survived long enough for anyone to read it, and the store held four more of the
same kind, each one occurrence short of being announced aloud.

An error is now counted only if it is **still present six seconds later**, re-read from
the editor rather than trusted from the event — the question is whether it is there
*now*, and the editor is the only thing that knows. Timers are tracked and cancelled on
teardown, like every other timer here.

Two related corrections went with it. `topPattern` surfaced anything seen twice while an
unsolicited remark needs three, so the briefing had a lower bar than the rule it was
meant to follow (§4.2: three times in seven days); it is the same bar now. And there is
a way to say *forget about it*, because the failure record only ever cleared itself when
that same job succeeded — which never happens for a probe, or a suite someone is
deliberately leaving red.

**Untestable, and worth being honest about.** The confirmation path needs a live language
server; nothing in the suite covers it. It was found by reading a briefing and will be
verified the same way.

---

---

#### M8 aftermath — the linter, and the split

Added after M8 closed, on a report that the project had "too much cyclomatic complexity"
with no number attached. Measuring it first mattered: 92 files, ~8,700 lines of
production source, and **five** functions at or near the limit. Not a sick codebase — a
handful of outliers, and a claim nobody could answer, which was the real problem.

`npm run lint` sets the ceiling at **15**, below ESLint's default of 20, because the two
worst functions sat at exactly 20 and the default would have declared the work done
without changing anything. Deliberately not a style linter: no formatting, naming or
import-order rules. The first run proved why — 433 errors, nearly all of them `test()`
from `node:test` returning a promise nobody awaits, which is the wall of noise that
teaches a team to stop reading lint output.

**What the refactor was actually for.** `ChatService` was 1,071 lines owning routing,
modes, runs, history, facts, voice and panel wiring. The complexity number was the
symptom; the disease was that all of those had the same reason to change, and every bug
lived in the seams — Stop wired to a signal agent runs never post, a reply that never
reached the archive, two owners of "is he busy". It is 453 lines of coordination now,
beside `Replier`, `RunSession`, `ChatActions`, `Transcript`, `Busy` and
`WorkspaceFactsReader`.

Three things worth carrying forward:

- **Extraction produced tests, not just shorter functions.** The providers' tool-call
  assembly — the place a malformed tool call comes from — lived inside a `for await` over
  a network stream and could not be tested at all. Pulling it out to satisfy the linter
  gave it its first six.
- **The refactor introduced a real bug, caught by re-reading rather than by the suite.**
  `AgentBranch.startAt()` read the previous branch back from `HEAD` *after* creating the
  new one, by which point HEAD is the new branch — undo would have offered to return you
  to the branch you were undoing. 411 tests passed throughout.
- **Optionality has a price at every call site.** Passing the run session in as optional
  pushed `ask()` from 18 to 21, purely from `?.`. Constructing it eagerly removed three
  branches.

**And it found two features that had been quietly lost.** The closing line of a run — where
it left you, and that your own branch is untouched — went to the terminal only, while the
comment above the loop claimed the chat received it. The aside after a summary
disappeared inside the commit that stripped machine talk from the transcript: it depended
on a variable that rework removed, so a thing asked for two messages earlier went with
it. Both restored. Neither was in any test, and neither had been noticed in use.

---

---

#### Security review (14 Aug) — three findings, all real

An outside reader went through the code and raised three things. All three held up
when checked, and one was worse than reported. Recorded because the pattern is now
consistent: the defects in this project are found by people using or reading it, not
by its own test suite.

**1 and 2 are one problem, and were fixed as one.** `shell: true` gives a command the
user's full authority; the deny-list is what compensates; compensating means
inspecting; inspecting a shell is a game you lose eventually. The first attempt at
this was to document the gap accurately, which was correctly rejected — editing a
README is not a fix for a security problem.

`sandboxProfile.ts` and `sandbox.ts`: commands run under `sandbox-exec` on macOS and
`bwrap` on Linux, with **one guarantee stated exactly** — a command cannot modify
anything outside the project folder and its build caches. Enforced by the kernel,
which does not care which interpreter asked, so the reported bypass dies with
everything else in its class. Verified against the real profile builder rather than a
hand-written profile:

| | |
|---|---|
| write inside workspace | ran |
| `rm -rf` outside | refused |
| `python3 -c "shutil.rmtree(…)"` | refused |
| append to `~/.zshrc` | refused |
| `> /dev/null` | ran |
| `git init` / `git status` in the workspace | ran |

**Two limits, stated rather than glossed.** Reads stay allowed, because toolchains
read from `/usr`, `/opt/homebrew`, `~/.nvm` and everywhere else, and a read-allowlist
would break builds constantly and confusingly. The network stays open because
`npm install` needs it. So destruction and persistence are stopped and exfiltration is
not, and the documents say so.

**Two details decided whether it worked at all**, both found by trying rather than
reasoning. `/dev/null` had to be explicitly writable — the first profile denied it and
every command redirecting output failed, and a sandbox that breaks `>/dev/null` is one
that gets switched off within a day and protects nobody. And paths must be resolved
before reaching the profile: `/tmp` is a symlink to `/private/tmp`, and a rule written
against the symlink silently matches nothing, which is indistinguishable from the
sandbox working.

Windows has no equivalent without native code, so it asks once per workspace and
remembers, like the `git init` offer. Declining refuses commands and leaves reading,
answering, planning and editing intact — refusing outright would have made Clarvis
useless there while pushing people to run the same command in a terminal, with no
gate, no snapshot and no log.

The workspace path is escaped into the profile: it is wherever someone keeps their
code, and a boundary a folder name can break is not a boundary.

**Inside the project, the answer is recoverability rather than prevention.** The
sandbox stops a command escaping the workspace; it deliberately does not stop a
command deleting the workspace's own files, because that is what a build does. So the
second half of finding 2: every write through the edit tools calls
`Checkpoint.capture` with the path it is about to change, and a command names no paths
— deleting a file with the edit tool was undoable and deleting it with `rm` was not. A
run now snapshots everything git has no copy of before anything executes.

Approval was also welded to `mode === 'agent'`, so the *default* mode asked nothing.
`asksFirst` is the mode's own property now: Auto asks, Unattended is the one mode that
does not, and it is named for the situation you would choose it in rather than for
being more capable, because "Full Auto" reads as an upgrade and people pick upgrades.

**A fourth finding, self-inflicted, found by being asked whether the review was fully
addressed.** `package.json` declared that an untrusted folder gets no commands and no
edits. VS Code enforces the `restrictedConfigurations` half; the rest was a sentence
nothing implemented, and no code anywhere read `vscode.workspace.isTrusted`. Precisely
the failure criticised two paragraphs above, and worse for living in the file that
grants the permissions. `requireTrust` now enforces it in the tool layer.

**3. A workspace could redirect the API base URL and collect the key.** The serious
one. `clarvis.chat.baseUrl.*` was window-scoped, so a `.vscode/settings.json` in any
cloned repository could point it at another server, and `resolveBaseUrl` had **no
validation at all** — the key went wherever it said, in a header, with whatever code
context accompanied the question. Fixed in three layers: the settings are
`scope: machine` so a project cannot write them, `capabilities.untrustedWorkspaces`
declares them restricted, and `acceptableOverride` validates what is left. The rule
follows the credential rather than the protocol — keyed providers get https or
loopback, keyless ones (Ollama, LM Studio) keep any http host, because a model server
on the machine under the desk is exactly what the setting was added for and banning it
would cost a real setup to prevent nothing.

---

#### M9f — Container isolation *(superseded, kept for the reasoning)*

**Largely answered by the OS sandbox above, and at a fraction of the cost.** Assessed
13 Aug, deferred, and then overtaken on 14 Aug when the security review forced the
question properly: `sandbox-exec` and `bwrap` deliver the containment a container was
wanted for, with no daemon to install, no image to pull, no bind-mount performance
cost and no breaking of native or hardware projects.

What a container would still add over the sandbox is network isolation — and that is
the part which cannot be turned on, because `npm install` needs the network in every
milestone one anyone would plan. Which leaves it buying very little.

The original assessment follows, unchanged, because the reasoning about what
containers do and do not buy is still correct and still worth not rediscovering.

**What it buys.** The deny-list (M8d) is a blocklist, and a blocklist is leaky by
construction: `curl … | sh` inside an approved step runs on the user's actual
machine. A container drops the blast radius of an unexpected command to the
container — their dotfiles, keys and other projects stop being reachable.

**What it does not buy, and this is the limit.** The workspace has to be bind-mounted
for the agent's read-after-write loop to work at all, so `rm -rf .` inside the
container still deletes the real files: it protects the *machine*, not the *project*.
And `--network none`, the setting that would make it a sandbox in any strong sense,
breaks `npm install` and every dependency step in every milestone one — so the escape
hatch most worth closing is the one that must stay open. Per-step approval and the
deny-list stay exactly as load-bearing as they are today; this is depth behind them.

**Shape, if it is ever built.** One long-lived container per workspace (`docker run
-d` once, `docker exec` per command) — a fresh `--rm` container per command puts
`npm install` and `npm test` in different worlds. Mount the workspace at *the same
absolute path* it has on the host, or a stack trace says `/work/src/app.py` and the
file tools, which run in the extension host, cannot find it. `--user` with the host
uid/gid, or Linux users get root-owned files in their own project. Image chosen by a
lookup on the interview's language with a generic fallback, never a model call.
Detection cached per session, and silent fallback to the host when Docker is absent —
§6's audience may not know what git is, and this can never stand between someone and
their first build.

**What it costs.** Native and hardware projects stop working entirely — a container
cannot read the thermostat on the Raspberry Pi that a live run planned. Bind-mount IO
across the macOS and Windows VM boundary runs test suites 2–4× slower. First image
pull is minutes, and would have to happen at plan time rather than mid-milestone.

**M9 as merged (14 Aug).** On `main`. What a user gets: arrive with one sentence or
with nothing, answer questions in the chat panel, rule on what he found wrong with the
idea, approve a `plan.md`, and watch him build it one milestone at a time — asking
before each step that changes anything, running the checks each step was written with,
and recording the results back into the plan before offering the next milestone.
Interruptions work in both directions: a correction folds into the run, new scope
stops it and is written into the plan first (§0's oldest unkept promise, kept). Nothing
is lost to a reload — half-finished interviews and part-finished milestones are both
offered back.

**M9d2 built (14 Aug), and worth recording why it nearly wasn't.** Every other gap in
this milestone was found by using the thing — the truncated shortlist, the empty
milestone, the interview lost to a reload. This one has no symptom: the plan rendered,
the agent built against it, and the missing section never announced itself. It survived
because dogfooding is good at finding things that behave wrongly and bad at finding
things that were never there. It also left two exit-checklist items unpassable, which
is the more objective tell and was sitting in plain sight.

`conventions.ts` renders §0's rules into every generated plan, adapted to the language:
PEP 8 and `snake_case` for Python, `gofmt` and wrapped errors for Go, `cargo clippy`
and borrow-before-clone for Rust. **A lookup, never a model call** — the person most in
need of these rules is exactly the person who could not tell an invented one from a
real one, so a language nobody wrote an entry for gets the universal set and says so
plainly rather than getting four plausible inventions. The comment-style question is
asked in the same final round as the linter, both options presented as legitimate, and
recorded in the plan. The handoff names the section rather than restating it: two
copies of a standard is one standard and one thing to drift from it.

**Still open in M9:** only M9f, container isolation, recorded above as assessed and
deliberately deferred.

**What the milestone cost, and where the defects came from.** Almost every bug in this
section was found by running it, not by the suite: the language shortlist truncated
mid-option, "you pick" recorded as the literal words, an empty milestone that gave the
agent nothing to build, a briefing that invented a test suite, `settings.json` reported
as the user's work when Clarvis had written it himself, and a generated opening line
rejected every time for its final punctuation mark. The tests caught the rest — the
step-result line landing in the wrong place, a normaliser that turned "There is no plan
in this project." into a question on its `is`. Both halves were necessary; neither
would have been enough.

---

#### Order matters: the sandbox first

`sandboxProfile.ts` was verified directly from Node against a real `sandbox-exec`.
The path that has **never executed** is the one inside the extension: `spawnFor`
resolving the caches, writing the profile into global storage, and wrapping the spawn.
Two failure modes, both quiet:

- **`which` not resolving in the extension host's environment.** `availableSandbox()`
  returns undefined, and a Mac that obviously has `sandbox-exec` gets asked whether to
  run commands unconfined. A silent downgrade, not a crash, and therefore easy to miss.
- **A confined command failing for the wrong reason**, which looks exactly like a
  command that legitimately failed.

**What to look for:** `sandbox:` lines in the log. `running unconfined (allowed for
this workspace)` on macOS or Linux means detection is broken and nothing below is
worth running yet.

**Ran it. Both failure modes were wrong about what would go wrong.** Detection worked
first time — `sandbox: using sandbox-exec on darwin`, then `confined by sandbox-exec`
on all three commands of a Go project. What actually happened was worse than either:

`brew install go` was denied its writes to `/opt/homebrew`, correctly. Homebrew cannot
see its own sandbox, so it reported the only cause it knows for a write it cannot make
— bad ownership — and told the user to `sudo chown -R` the tree. Clarvis passed that
on as fact. **The directory was owned by them and perfectly writable.** Following the
advice meant a recursive chown over a working install to fix a problem that did not
exist.

That is a sandbox producing dangerous advice by working exactly as designed, and no
amount of testing the *profile* would have found it: the profile was right. The fix is
`confinement.ts` — when a confined command fails on something that reads like a denied
write, the result carries a note saying so, telling the model not to repeat the
diagnosis and not to suggest `sudo` or `chown`. Matched rather than always attached,
because a note on every failure teaches it to blame the sandbox for its own bugs.

**Two things follow from it, both built the same day.**

*The escape at the gate.* `brew install go` was gated as a dependency, approved, and
then denied by the sandbox — an approval that could not be honoured. Confinement is
the actual obstacle for an install, so that gate now offers a second button:
*Run it unconfined*. Deliberately narrow, and narrow in a way that is checkable
(`mayEscapeConfinement`): installs and privileged commands only, never `rm -rf`, never
a force-push, because the sandbox was not what stood in their way. Per command, never
remembered — a remembered yes is an unconfined agent with extra steps. The dialog
spells out both buttons, since two that read "run it" teach people to click the right
one.

*Bubblewrap on Linux.* macOS ships `sandbox-exec`; Linux ships nothing, so the Linux
path was "no sandbox here, shall I run unconfined?" — a security question asked of
someone one `apt-get install` away from not having to answer it. Now it offers to
install it first, for the five package managers that cover the desktop distributions.
**The command is handed over, not run**: a terminal opens with the line in it,
unexecuted, and the user presses Enter so their own shell asks for the password. An
extension that runs `sudo` on your behalf has become the thing the sandbox exists to
prevent. That makes a third answer necessary — neither yes nor no but *ask me again in
a minute* — because reporting it as a refusal would have the model looking for a way
round a door being unlocked.

**Also found, same run:**

- `listFiles` was called with `"."` — quotes included — and the path resolved to
  `<workspace>/"."`. A step lost to an ENOENT on the workspace root. Models write what
  they would type in a shell, where the quotes are the shell's to strip. Now stripped
  at `resolveInWorkspace`, the one boundary every tool goes through.
- The run stopped to ask a question; the user replied "retry", then "continue". Both
  reached a model with no idea what was being retried, which asked what they meant.
  `takeUnanswered()` was being consulted *inside* the job branch, and neither word
  routes as a job. A reply to a stopped run is an answer to it whatever it looks like,
  so the check now happens before routing.

---

#### Project 1 — run 15 Aug, and what it showed

**Worked, first time:** the vague answer pushed back on exactly once; the language and
comment-style questions both landed; three findings, the safety one carrying *two*
fixes as separate buttons; three milestones; the checkpoint capturing each new file;
branch isolation; and `sandbox: confined by sandbox-exec` on all ten commands.

**The confinement note earned its place immediately.** Step 8 was
`mkdir -p /tmp/photochrono_test && python3 -c …` — building a test fixture outside the
project. The sandbox refused it, the note said so, and step 9 was the same fixture
written to `tests/fixtures` *inside* the workspace. No sudo advice, no misdiagnosis,
recovered in one step. That is the whole design working in the order it was designed in.

**The defect: a path repeating the workspace folder's own name.** The workspace was
`1-photo-renamer`, and the model asked for `1-photo-renamer/plan.md`, which resolves to
`…/1-photo-renamer/1-photo-renamer/plan.md`. Three tool calls across two turns, and the
run stopped mid-milestone having read nothing — it reported the first three steps done
and gave up on the fourth.

The mistake is structural, not careless: absolute paths appear in command output, in
`pwd`, and in the ENOENT from the previous attempt, so everything the model can see
about where it is contains the folder name it must not repeat. Repaired at
`resolveInWorkspace`, and only where the evidence is unambiguous — the doubled path
must not exist and the shortened one must. A project whose root and package share a
name (`mytool` containing `mytool/`) is normal, and there the doubled path *does*
exist. The ENOENT message now also says paths are workspace-relative, since the old one
quoted an absolute path and was therefore an argument for repeating the mistake.

**And five editor tabs for one plan.** The verdict summary opened an untitled
document, each refinement round opened another, `markdown.showPreview` doubled every
one of them, and the approved `plan.md` arrived alongside the lot. Two tabs read
`# Photochrono` — an untitled markdown document is named after its own first heading —
so the pair that looked identical were a scratch draft and a rendered view of that same
scratch draft, neither of them the file. One `DraftDocument` now owns a single tab,
redrawn in place through a `WorkspaceEdit`, and closed the moment `plan.md` exists: a
draft sitting next to the file it became is ten minutes spent improving the copy that
gets thrown away.

**Also confirmed working from the previous round:** `listFiles: .` arrived unquoted.

**What project 1 verified, and what it only looked like it verified.** 42 tool calls,
ten of them commands, all confined. Proven: the interview end to end, the push-back
firing exactly once, multiple fixes offered as buttons, three milestones planned, the
checkpoint capturing five new files, branch isolation onto
`clarvis/start-building-photochrono-…`, and undo restoring the lot on request.

Not proven, and worth not claiming: **no dependency was installed.** The agent ran
`pip3 show` four times — checking, not installing — because Pillow and piexif were
already present, so the dependency gate never fired and a `pip install` has still never
run under the sandbox. The git-init offer did not fire either, this folder having been
`git init`-ed during setup. Both were things project 1 was chosen to force, and neither
happened; project 2 is where they get another chance.

The milestone never completed, so everything in *The loop itself* below is still open —
the run stopped at step 4 of 5 on the path defect and the work was undone deliberately.
That is one defect away from a finished milestone rather than a failed design, but the
distinction is exactly what a checklist is for and the boxes stay empty.

---

#### Project 2 — the git offer fired too late to be an offer

Reported live, part-way through the interview: no `git init` prompt in a folder chosen
precisely because it had no repository. It was not missing — `offerGitFix` runs from
`RunSession.run()`, so it would have appeared before the first build. But that is after
the interview, after the analysis, and **after `plan.md` has been written into a folder
with no history**, which is the one artifact the offer exists to protect.

Moved to the start of planning, and asked *in the chat* rather than in a modal: at that
point there is a conversation to put the question in and the interview's own buttons to
answer it with. The probe, the decline and the action are split out of `offerGitFix` so
both surfaces share them — one answer per workspace, whichever collected it, so the run
that follows an accepted offer does not ask again.

**Two more from project 2, both about attention.** A mode change mid-run did nothing:
step approval was read once when the run started, so switching to Unattended — which
people do precisely *because* a run is going well and they want to stop shepherding it
— went on asking until the run ended. The decision is per step now, taken from the mode
as it is at that moment. (Auto still asks; `asksFirst` is true for it by design, and
Unattended is the mode that does not.)

And a question nobody notices parks the whole build. So an unanswered one is now
**spoken**, at 45s, then 90s, then 180s, escalating in what it says rather than in
temper — a nudge, then what is stuck, then the consequence — and stopping after three.
Someone who has not answered in five minutes has left the desk, and a voice repeating
itself into an empty room is what gets a product uninstalled. Spoken rather than
written for the obvious reason: another line in the panel is the one thing guaranteed
not to reach someone who is not reading the panel.

**Project 2's build: nine steps, no files, and a cheerful sign-off.** The interview and
the plan were fine — four milestones, the git-init offer taken, the step questions
arriving in the chat with their explanations, `Do it` answered four times, every command
confined. Then the run read the plan, checked `go version`, called the weather API
twice, and spent a step on `cd /Users/clarvis 2>/dev/null; pwd; find / -maxdepth 1 -name
"*.git"` — inventing a location out of the product name and searching the filesystem
root for it. It stopped with an empty summary having written nothing.

Two defects, and the second is the worse one.

**He was never told where he is.** The brief said "you can only touch files inside the
workspace" and never named the folder. Everything the model knew about its own location
came from command output, which is how `1-photo-renamer/plan.md` happened yesterday and
how `/Users/clarvis` happened today. The root is now in the prompt, with the rule that
every path is relative to it. `agentSystemPrompt` moved to its own `vscode`-free module
to be testable at all — the prompts are the part of this codebase most worth testing,
since nearly every behavioural regression here has been a sentence rather than a branch.

**And the run reported as though it had gone well.** There is already an honest line for
a run that changes nothing — *"I stopped without changing anything, and without saying
why"* — and it did not fire, because the closing note about branches was being joined to
the narration upstream. An empty narration plus a branch note looked like a summary. So
the chat showed "your own work on `master` is untouched" followed by an aside about the
hard part being over, about a run that had built nothing at all. They travel as separate
fields now, and the branch note goes *after* what was said rather than instead of it.

**Quit mid-interview, and he offered to start from nothing.** Closed at the scope
question, reopened, and was greeted with "an empty folder, nothing built yet" — a
description of a folder that had a three-answer interview saved against it.

Nothing was lost: `clarvis.planning.interview` held the seed, the name and all three
answers, written after each one. **The offer was in the wrong place.** `offerResume`
sits inside `runPlanning`, so it only fires once someone has already agreed to plan —
which is a question they now have no reason to say yes to, having just been told this
was a blank folder. The resume was one accepted offer away from appearing and might as
well not have existed.

It is asked at startup now, before the new-project offer, with its progress named and
the same three answers `runPlanning` would have given. The choice is handed down so it
is not asked twice — two identical questions in a row reads as the product not
listening.

---

#### Project 2 finished milestone 1 — the first end-to-end success

15 Aug, third attempt, and the first time this product has taken a sentence to working
committed code: interview resumed from a closed window, four milestones planned, the
plan approved, and 20 steps producing `main.go` and `internal/weather/weather.go`,
built with `go build`, run against the live open-meteo API, `gofmt` and `go vet` clean,
and committed to its own branch. The results went back into `plan.md` with each check's
*real* output — including a deliberately invalid host used to prove the
unreachable-server path, then reverted. Milestone 2 followed on request; milestone 3
started from a typed instruction.

**Everything the sandbox work was for held up**: every command confined, two `rm -f`
lines stopped at the destructive gate and approved by hand, and the Go build wrote to
`~/go` without complaint.

**The nudge earned its place on the day it shipped.** Five questions went unanswered
long enough to be spoken about — "Still waiting on you: Edit main.go" — during a
twenty-minute milestone. Without it each of those was a build parked behind a panel
nobody was looking at.

**Two defects, both small.** The model called a tool named `STEP`, having read the
step-marker instruction as a tool contract rather than a request for a line of text;
it cost a step and it recovered. Both handoff prompts now say plainly that there is no
such tool. And `stackedAdvice` printed **"I couldn't start cleanly from `your branch`"**
— a placeholder quoted in backticks, which reads as the name of a branch that does not
exist. It now describes the unknown case instead of quoting a stand-in, and moved to
`branchNames.ts` so the wording can be tested at all.

**Switching to Unattended mid-run, tested on milestone 3 — and it still asked once
more.** The switch happened at 09:58:10 with step 24 already waiting for an answer (the
nudge had chased it 45 seconds earlier), and the button still had to be pressed. The
run then finished, so no later step ever exercised the live check.

The per-step fix was right and insufficient. Someone switches to Unattended *because*
answering has become the annoyance, and usually while looking at the question that made
it one; leaving that question pending means the switch appears not to have worked. A
mode change that stops the asking now releases the step already on the table. Wired to
a configuration listener rather than to the picker, so it fires however the mode was
changed — and it releases *step* questions only. The deny-list gate is not a mode
setting: `rm -rf` stops and asks in every mode, Unattended included.

Also worth recording from that run: **Auto and Agent are identical for approvals**, so
the earlier agent-to-auto switch was a no-op and verified nothing. Nine steps asked and
were answered after it, which is correct for both modes and would have looked the same
before the fix.

**And the offer was unreachable anyway.** Fixing the `done > 0` rule was necessary and
changed nothing, because `offerToResumeBuild()` sat *after* a guard that returns when
`plan.md` exists — and a build in progress always has one. Written with the comment "a
build already under way is offered before anything else", placed where it could never
run at all. Reloading with milestones 1 to 3 finished still produced silence.

That is the second ordering bug in this file in two days, both one line in the wrong
place inside a long method, and neither visible to a test because the method needs a
workspace, a panel and a model to run. The order is now a pure function —
`startupOffer` — taking three facts and returning which of the four things to say. A
build in progress wins and *requires* the plan to exist, which is exactly why it cannot
live behind a does-the-plan-exist guard.

**Finishing a milestone was the one moment "in progress" could not see.** Milestones 1
to 3 done, milestone 4 untouched, window closed — and reopening it offered nothing.
The build had to be restarted by hand with "start milestone 3 from plan.md".

`interruptedBuild()` tested `milestone.done > 0`, meaning progress inside the *next*
milestone, which is a different question from whether this project is being built.
A finished milestone is the most likely moment for someone to close the window, and it
produced the one plan state that read as untouched. It now asks whether anything
anywhere in the plan is ticked.

The offer needed two shapes as well, since one line covered both badly: mid-milestone
is "milestone 3 is 2 of 5 done, shall I carry on with it", and a finished one is
"milestone 4 is next: Finalize the user-facing interface. Shall I start on it?" —
reading "milestone 4 is 0 of 2 done" back to someone who has just finished three of
them describes their progress as nothing.

---

#### Project 2 finished — and the ending was the weakest part of it

All four milestones built. The closing line was **"That's Milestone 4 finished —
Milestone 5, if there is one, is a separate conversation."** There were four, and the
plan he had just been told to read said so on every heading.

`nextMilestoneTask` named the milestone and never its position: "Milestone 4 —
Finalize the user-facing interface", with no total. So the build could not tell whether
it had finished the project, which makes every "done" it reports provisional. A build
that cannot say when it is finished is one you have to check on, and checking on it is
the work this was supposed to remove.

Three things follow, all from the same fact — the plan already knows.

- **Position.** "Milestone 4 of 4", and on the last one: *the project as planned is
  finished — say so plainly rather than wondering aloud whether there is another. There
  is not.* The stop instruction changes with it; telling him to stop before a milestone
  that does not exist is what produced the question.
- **What is still coming.** The later milestones are named, with "do not build any of
  that now. Knowing it is there is enough." A cache written in milestone 2 with no idea
  milestone 3 is a week forecast is how a build paints itself into a corner one
  milestone at a time.
- **An ending.** The last step ticked used to produce a *notification* — the one place
  a finished project was guaranteed not to be mentioned by the butler who built it —
  and then silence. It is announced in the conversation now, with what the project
  consists of: the milestones by name, the step count, and where the recorded results
  are. No congratulation and no exclamation mark; the aside afterwards is written
  separately, as every other report's is.

Both call sites pass the milestone list, including the resume-build path, which is the
one that started milestone 4 in the first place.

**Eight branches, stacked in a straight line, and nothing ever offered to land them.**
Every request made its own `clarvis/<task>` branch off the *previous* run's branch:
`commit changes` → `clarvis/commit-changes`, then a gitignore branch on top of that,
then — the one that gives it away — asking to merge to main produced a branch called
`clarvis/merge-to-main`. Each run opened with "I couldn't start cleanly from where you
were", which was true and read as an apology for a situation nothing was fixing.

The review wizard has had merge, return and discard since M8, with `Merge into <branch>`
first in the list. It is reachable only through `clarvis.reviewRun`, a command nobody
knows exists — so the work never went home, the next run branched off the temp branch,
and the repository grew a branch per sentence.

A run that committed something now asks at the end, in chat, with buttons: **Merge into
`<home>`** (the work and the user, back where they were), **Show me what changed**, or
**Leave it there**. Nothing new was built for it — the command takes a decision made in
chat and skips its own picker, because asking the same question twice in two different
widgets is worse than not asking at all. Runs that changed nothing say nothing, and a
run already on its home branch has nothing to ask about.

---

#### The M6 pass, first afternoon — and what a deliberate error proved

A syntax error was left in `nanocode.py` on purpose, to see what he would say. He said
nothing, and **that is the specification working**: `PatternMemory` consumes the
diagnostic, waits to see whether it survives, records it as occurrence *one of three*,
and §4.2's threshold means nothing is said until the third in seven days.

So the answer to "will he point out my mistakes while I type" is **no, and by design**.
He notices immediately and mentions it only when it becomes a pattern. That is right for
a working developer who does not want a second linter, and it is an open question for
someone following a book, who has no idea whether silence means approval.

**Two defects fell out of looking, though, and both are the same defect this project
keeps finding.**

*Occurrences one and two logged nothing.* A log with no `pattern:` lines meant either
"seen twice, waiting" or "diagnostics never arrived", and there was no way to tell them
apart — the identical mistake the sandbox made, fixed there a day earlier for the
identical reason. Every occurrence is logged now, with its count and the threshold it is
counting towards.

*Declining the planning offer was not an answer.* "No" cleared the flag, logged the
decline, and then **fell through to a normal reply**, so the answer to his own question
was met with "That is not a question. I remain here, unimpressed but ready." Three times
in one afternoon, because the decline was also never remembered — the offer returned on
every window open in a folder where it had just been turned down, which is §6's nagging
with a straight face. It is now consumed as the answer it is, acknowledged in one line,
and remembered per workspace; `Clarvis: Forget branch answers` clears it along with the
git offer, both being "you said no once, here".

---

#### Asking is now a way to find out — §4.2's threshold, answered from the other side

The M6 afternoon left an open question rather than a defect: pattern memory speaks at
the third occurrence in seven days, which is right for a colleague and leaves a learner
unable to tell "fine" from "not looking". Lowering the threshold would have made him a
second linter, which §6 exists to prevent.

So the threshold is untouched and the question is answerable instead. *"Anything wrong
in here?"* now reads the diagnostics of the **file on screen** — line numbers, messages,
errors before warnings, five listed and the rest counted — and says so plainly when
there are none, naming the file, because a silent answer is the ambiguity this was meant
to remove.

Three details worth keeping:

- **The active editor, not the workspace.** "In here" means here. A project can carry
  forty problems in files nobody has open, and answering with those answers a different
  question.
- **1-based lines.** The editor counts from zero and displays from one; the number said
  out loud has to match the gutter or it sends someone to the wrong line.
- **Both paths, not just the free one.** The detail goes into the facts block as well as
  the no-model answer — the model path wins whenever a key exists, so anything reaching
  only the fallback would never be seen by someone who has one.

§4.6 already listed active-file diagnostics among the bounded context a reply may draw
on. Nothing had ever supplied them; the facts carried counts, so the best answer
available was how many things were wrong rather than which.

---

#### Lingering errors — the trigger §4.2 was missing

Asking works, but it still required knowing to ask. **The third occurrence is the wrong
trigger for a first mistake**: §4.2 answers "is this a pattern", and the person staring
past a missing colon needs "this file is broken now", which nothing answered.

So an error confirmed present is watched, and if it is *still* there three minutes later
it is mentioned — once, with the file, the gutter line and the editor's own words.

Three properties keep it from being the linter §6 exists to prevent:

- **Three minutes, not a keystroke.** A half-typed line, a paste being tidied, a rename
  the language server has not caught up with — all produce errors that mean nothing, and
  all are gone inside the window. Anything fixed while working never surfaces.
- **Once, ever, per error.** Still broken twenty minutes on is a decision, not news.
- **Through the same budget.** It goes out via the Announcer like every other
  unsolicited surface, so it queues behind a failing build rather than talking over one,
  and mute silences it with everything else.

The wording earns a note of its own. "Has been unhappy for a few minutes now" is a
*measured* duration — we watched it arrive and re-checked three minutes later — where
§4.2 is explicit that the editor cannot say when a diagnostic first appeared. It is the
honest version of the invented "for the past six minutes" that produced rule 6, and the
vagueness is what makes it true: we know it is minutes, not how many.

---

#### An offer has three answers, not two

The decline fix shipped and broke something within the minute. Declining used to fall
through to a normal reply — "No" met with *"That is not a question. I remain here,
unimpressed but ready"* — so the fix consumed everything that was not a yes. Seconds
later, in the same session, *"anything wrong in here?"* arrived while the offer was up,
was filed as a decline, and got *"Noted. I will not bring it up again here."* The
question had to be asked twice.

Both versions treated one question as two possible answers. There are three: yes, no,
and **they have moved on** — and the third is the common one, because an unprompted
offer appears while someone is already typing something else.

`offerAnswer` is deliberately conservative. Only a recognisable yes or no counts;
anything containing a question mark is never an answer, however it starts ("no idea,
what is wrong here?" opens with a refusal and is plainly a question); and a refusal
inside a longer sentence is not a refusal, or "there is nothing wrong with it" files
itself as a decline. Everything else drops the offer without recording a decision
nobody made, and the message routes normally.

---

#### The lingering mention fired, and the first firing found two defects

14:38:58, three minutes after three errors were confirmed in `nanocode.py`. The whole
chain is legible in one log burst: three timers landing together, §6's budget letting
**one** through and suppressing the other two, and the survivor rewritten in character.

Both defects are in that sentence.

**The rewrite paraphrased away the useful half.** In went `nanocode.py line 18 has been
unhappy for a few minutes now: "(" was not closed`. Out came *"nanocode.py line 18 is
waiting for you to tell it what comes next"* — charming, in character, and no longer
saying what to fix. `Announcer.announce` had no `keep` list, so the one part that is a
fact rather than a mood was the part the model felt free to lose. It now passes the
file, the line and the editor's own words as literals.

**And the two suppressed remarks were recorded as said.** `mentionedLingering` was
written before delivery was known, and the rule is once-ever — so lines 18 and 24 were
marked mentioned by a remark nobody heard, and would never have been raised again. The
surface now reports whether the budget let it through, and only a delivered remark
counts.

While fixing it, the better shape for a burst: other unmentioned errors in the same file
are **counted rather than queued** — "and 2 more like it" — so one remark carries what
three timers knew, instead of one remark and two losses.

Worth noting what worked untouched: the budget did exactly what §6 promises, the pattern
threshold fired independently on the same file (`surfaced 70a274db635c8571 (3×)`), and
the pre-existing errors from the previous session were correctly skipped as not-ours.

---

#### "Three times this week" was the whole line

Reported on sight as too vague, and it was. The pattern-hit surface said *"That's 3
times this week. No fix on record yet — I'm watching."* — a count and nothing else. No
error text, no file, no line. A recurring error you cannot locate is a recurring error
you cannot fix, and the only fact in the sentence was the number.

Worse than useless: with nothing specific to carry, the rewrite filled the gap. What
reached the user attributed a *motive* — that they knew about the problem and had chosen
not to fix it — which the store cannot know and §2 rule 4 does not allow. Give the model
a sentence made only of mood and it will supply the substance.

It now carries the error, the file and the gutter line, all measured: the count from the
store, the sample from the editor, the location from the diagnostic just confirmed, and
the remembered fix labelled as the guess it is. All of it in the `keep` list, since
every one of those is a thing a paraphrase could send someone to the wrong line with.

> That's 3 times this week — nanocode.py line 19: Expected expression. No fix on record yet.

---

#### Borrowing Agent for one job

"Fix my code" in Chat only produced *"That's a job, and Chat only won't let me change
files. Switch to Agent or Auto and ask again."* Correct, and it set homework: change the
mode, retype the request, to reach a thing Clarvis could plainly see was wanted. The
restriction is worth keeping. Making someone re-ask for it is not.

He offers instead — **do it in Agent mode**, **tell me what you would change**, or
**leave it** — and on the first, switches, runs the one job, and hands the mode back in
a `finally`. Borrowed, not moved: someone in Chat only chose that deliberately, and one
fix is not a decision to leave the safety catch off.

**Unless they moved it themselves mid-run**, in which case the newer choice is theirs
and stands. Same rule planning already follows when it hands off to a build, and the
same reasoning: a method that overrules the user about their own editor is worse than
the inconvenience it saves.

Two structural notes. The offer uses `PendingChoice` — the mechanism the interview and
step approval already share — rather than a sixth `awaiting…` flag on `ChatService`,
which is the drift that made that file hard to follow. And the reply to it is taken
*after* the stop check, never before: "stop" has to mean stop even when something is
waiting on an answer, or the one word that must always work becomes the one word that
does not.

---

#### Every lingering and pattern notice opened the same way

"Line X has been unhappy" every time — reported live, correctly. Both surfaces called
`phrase()`, which *rewrites*: handed a finished sentence and a list of literals to keep,
the model paraphrases the same opening rather than writing one. With a strong template
and a tight `keep`, "line 18 has been unhappy for a few minutes" came back as a
variation on itself, three sessions running.

`opening()` is the other path this project already has — the one the briefing uses —
and it takes facts, not a sentence: `lingeringSituation()` and `patternHitSituation()`
describe what happened, and the model writes an original line about it, exactly as it
does for "welcome back" each morning. Both went through `announceWith` rather than
`announce`, so the model is asked only when §6's budget will actually let the answer
through — no request spent on a remark nobody hears.

**The literal-preservation rule needed a second pass, found by checking against a real
model rather than trusting the design.** The first version asked for the whole error
message verbatim and rejected three of four genuinely good lines — models naturally
paraphrase message text ("not closed" for "was not closed"), and requiring it exactly
defeated the entire point of asking for variety. Loosened to what actually matters: the
**file and the line number** are required, because those are what send someone to the
wrong place if wrong; the message itself is free to be said differently, being where
the variety was wanted in the first place.

The instruction format needed a second look too. Literals joined by `·` in the prompt
were echoed back verbatim, format and all — three sessions in a row, before the fix.
Quoted, one per line, with an explicit "weave these into your sentence" instruction,
and the model stopped copying the shape of the instruction as if it were the answer.

Four real lines from one situation, after both fixes:

> nanocode.py, line 18, "(" not closed for about three minutes now — I've seen slower crimes solved.
> Three minutes on line 18, and "(" still hasn't found its match in nanocode.py.
> nanocode.py, line 18, three minutes now — "(" was not closed and neither, it seems, is the matter.
> nanocode.py's had an open "(" since line 18 for three minutes now — I've seen turtles close faster.

Falls back to the written line when there is no model, the attempt times out, or the
file and line do not survive — the same fallback that was always correct, now the floor
rather than the ceiling.

---

#### "Can you fix my code?" was answered, not agreed to

The Agent-borrowing offer was never reached. "Can you fix my code?" ends in a question
mark, and `routeFor`'s first rule was `message.endsWith('?')` → answer — checked before
`WORK_PHRASES`, which already recognised `can you fix` as work and has since `WORK_VERBS`
first went in. The offer built to solve exactly this sat downstream of a routing decision
that never let the message reach it: he read the file, listed three real defects, and
signed off with "they're all yours to fix through the editor; I can't write files in this
mode" — correct about the mode, and a non-answer to what was asked.

`WORK_PHRASES` now runs before the blanket question-mark rule. Not a general reordering —
this is the one shape of question that is unambiguously a job wearing a "?" as a courtesy,
and every other question rule is untouched. `could you fix` joined `can you fix`; `would
you` was tried in the same edit and immediately broke "what would you change about this
file", which is an opinion question — "would you" is common enough in ordinary phrasing
that treating it as a request would misroute more than it fixed. Left out on purpose.

---

#### The privacy pitch overclaimed, and a second reviewer caught it

An outside review of `README.md` and `plan.md` — run through a
different model, not by using the product — flagged the elevator pitch, *"it can only
see — and only touch — the workspace it was born in,"* as contradicting §4.6's own
threat model two sections later. Checked before agreeing with it, since a review is a
claim like any other: `sandboxProfile.ts` opens with `(allow default)`, meaning reads are
unbounded and the network is untouched, and the file's own comment already says so.
The claim was real. Worth recording that of the review's two "release blocker" findings,
this was the one still open — the other, dirty-file commit isolation, had already been
fixed in a live session (`dirtyAtStart.ts`) before the review reached us, and the
review's own recommended fix matches what shipped almost exactly.

**Fixed at three sites, all saying the same wrong thing.** The README pitch, and two
copies in plan.md — one in §1's goals table, and, worse, one inside §4.6's *"Privacy —
restated honestly"* section, which existed specifically to correct an earlier
overclaim and had drifted back into making one. All three now split the claim in two:
Clarvis's own tools (read, edit, search) are workspace-bound, provably, because the
tools themselves cannot resolve a path that leaves it. A *command* he runs, with
approval, reaches what the toolchain needs and the network, the same as if typed in a
terminal — and still cannot **write** outside the workspace or its build caches, which
is the sandbox's actual, narrower guarantee. "Can't touch anything outside the project"
stayed true throughout; "can't see anything outside the project" was never true of a
command, only of Clarvis himself, and the pitch didn't say which one it meant.

Closing the gap the review actually points at — per-command network confinement, so a
command that reads a secret is also stopped from sending it anywhere — is not done here.
This is the wording fix; the mechanism is separate work, queued behind M9's remaining
checklist rather than gating it, per the disagreement recorded with the review's
proposed moratorium on building anything else until every item lands.

---

#### A §0 audit of the codebase, and the refactor pass that followed

**Why an audit rather than a tidy-up.** §0's clean-code rules travel: §4.9 writes an
adapted copy of them into every `plan.md` Clarvis generates. They have to be true here
first. Two of them are already mechanical — eslint enforces `complexity: 15`,
`max-lines-per-function: 120`, `max-depth: 4`, and the suite is green — so the audit
looked only at what a linter cannot see, measured with the TypeScript compiler API over
all 171 source modules rather than by regex. That distinction earned itself: the crude
scan that seeded the brief reported several 250-line functions in `Interview.ts` that
turned out to be `log(` calls.

**Most of §0 is being kept, and saying so is part of the measurement.** Law of Demeter:
two hits, both string-method chains. `return null` for a collection: none. switch where
polymorphism fits: one switch, on `process.platform`. Tests: 1,004 of them, 1.3% with six
or more assertions and those table-driven, zero generic names. Naming: no `data`, `info`,
`manager` or Hungarian anywhere. Dead code: three unreferenced exports out of 558. And the
comment deviation — the thing a generic refactor pass would have "fixed" — was scanned
across all 37,419 lines for comments restated by the line below: six candidates, all six
false positives. There was nothing to delete.

**What was actually wrong, in order of what it cost.**

*One import kept 879 lines out of the test runner.* `Interview.ts` — the module behind six
of the twenty runbook findings — had no tests, and the reason was `researchWorkspace`,
imported once and called once at line 84, which needs `vscode`. `node --test` could not
load the file at all. `PlanningFlow` reads the workspace now and hands the result in. This
is `CURRENT_STATE.md`'s sixth recommendation applied *before* a fix inside the file
shipped broken rather than after, which is how it was learned the first time.

*Two comments claimed an invariant the code did not hold.* Both providers' `post()` says
"Shared request setup, so the two streams cannot drift apart", and in both files `stream()`
did not call it. They had drifted: Anthropic to two undocumented `max_tokens` budgets, 4096
and 2048; the OpenAI adapter to two message mappings and two frame parsers, one of them
re-inlining `readFrame`'s try/catch and log string verbatim. The budgets were deliberate
and survive as a passed argument. The **read loops were left alone on purpose**:
`streamWithTools`'s `[DONE]` breaks only the inner payload loop where `stream()`'s breaks
both, and unifying that is a behaviour change in an edge case rather than a refactor.

*Thirteen copies of one idiom, with the caps already drifted.* Every phrasing call reads a
stream into a string, stops at a character limit, and swallows only its own abort. Four
files had it as a private `collect()`; eight more inlined it. The caps had reached 40, 300,
400, 500, 800, `topic === 'language' ? 2000 : 400`, and a shared constant, far enough apart
that nobody could see them together. `if (!signal.aborted) throw error` — the subtle half,
since letting an abort through turns every timeout into an error and swallowing everything
hides a real provider failure — now appears exactly once in the tree.

*Twenty flag arguments, of thirty-two boolean parameters.* Classified by whether the body
actually branches on them. Eleven were fixed and nine were left, with reasons; see below.

**Where the pass deliberately stopped.**

*The Git extension is reached from eight places, not the two the audit measured.* Five
separate `GitExports` interfaces. The two that were byte-identical are now one
`firstGitRepository`. The other six are recorded rather than merged, because they differ
in a way that matters: `BranchFlowWatcher`'s copy documents a defect this project already
paid for — *"`isActive` is false during our own activation — checking it and giving up is
how the watcher came to never run at all"* — and three of the remaining copies
(`reviewWizard`, `AgentBranch`, `commandTools`) still check `isActive` and give up. All
three run well after activation in practice, so this is a latent divergence rather than a
live bug, and unifying it means making three synchronous functions async. That is a scope
conversation, not a refactor.

*`isEscalation` has no production caller, and the rule it implements may not be shipped.*
§4.6 says replying to an unsolicited remark is what turns it into a request — "go on then"
after a pattern hit is an instruction, the same words unprompted are not. `isEscalation`
is that rule, and nothing but its own four tests calls it. What the product actually runs
is `isDoItNow`, the same regex without the guard, gated on `hasLastAnswered` — and
`lastAnswered` is set only by `answerQuestion`, when Clarvis has answered something the
user asked. An unsolicited surface never sets it. So replying "go on then" to a pattern hit
appears not to escalate. Not touched: that is a behaviour question, and this pass changed
no behaviour.

*Nine flag arguments were left, and the reason is the same for most of them.* §0 says
split into two named functions, and that is right when the body is two functions in a
trenchcoat — `AgentRunner.completed(readOnly)`, whose entire body was `if (!readOnly)` four
times over, split into a three-argument function and a no-argument one. It is wrong when
the boolean is a *fact being reported* rather than a mode being selected:
`handleBusyChange(busy)` is an event payload, `noteOutcome(succeeded)` is the outcome the
function exists to fold in, `afterReply(aborted)` and `askGate(confined)` and
`planJob(hasLastAnswered)` are facts ANDed into a condition, and `isInside(caseSensitive)`
is a property of the filesystem relayed twice inside one function — at the containment
boundary, where changing a signature for style right before a release is a bad trade.
Where splitting would only have moved a ternary one level up into a caller that was
itself handed the boolean, the flag became a named union instead — `OpeningKind`,
`PlanBacking` — which fixes the unreadable `f(x, false)` call site without writing eight
near-identical functions. `tsc` then named seven more sites a boolean had been accepting
silently, which is the second argument for the union and turned up on its own.

**Two things worth recording about the method.**

The sandbox change is the one that had to be verified against the real mechanism rather
than the diff, and was: every profile and argv the new code generates is byte-for-byte what
`main` generates, checked by building both and diffing three inputs; and a real
`sandbox-exec` run confirmed a write inside the workspace succeeds, a write outside gets
"Operation not permitted" and creates no file, `network: 'denied'` gives curl 000, and
`network: 'allowed'` gives 200 — that last one being the check that proves the polarity is
not simply stuck closed.

And splitting `AgentRunner.completed` put a ternary in `loop` and took it from 14 to 15,
leaving no headroom in a function `CURRENT_STATE.md` names as one that keeps needing to
change. Measured against `main` rather than assumed, and paid back in the same pass by
collapsing `loop`'s two mode ternaries into one.

---

#### The tool probe's third answer had nowhere to live

Found from the other side of the wire. RAVIS — the routing gateway Clarvis talks to as
an OpenAI-compatible provider — was changed so that a request no model could serve
answers `502` instead of a misleading `200`. That is correct on its side, and it broke
tool support here: `supportsTools` read any non-ok status that was not 401, 403 or 429
as *the model saying no*, and `ModelService` remembers the answer for the session
(§4.6). A model that calls tools perfectly was recorded as unable to, until the window
was reloaded.

The probe asks a three-valued question — yes, no, or could not tell — and only the
first two had anywhere to go. `toolSupport` is a `Map<string, boolean>` and
`supportsTools` returns `Promise<boolean>`; "could not tell" was expressible only by
throwing, and the throw was gated on a list of three status codes.

**This is the second time.** The first was a bad credential: a 401 cached
`tool support = false` and left the agent path disabled after the key was fixed. The
fix then was to special-case 401, 403 and 429 — the instance, not the rule. Every
status nobody had thought of still landed in the same trap, which is what a gateway's
502 then demonstrated.

The rule, replacing the list: **a 4xx is the server understanding the request and
rejecting it**, and the only unusual thing in a tool probe is its `tools` parameter, so
that is an answer. **Anything else is the server failing to answer at all** — a
gateway's 502, a runtime's 503 while a model loads, a timeout, a refused connection.
Access statuses stay the exception inside 4xx, because 401, 403 and 429 are about the
key or the quota rather than the request body. `probeAnswered` is that sentence, and
its tests are written against what a status *means* rather than against the four codes
that have burned us so far.

The `catch` arm had the same defect and was fixed with it: a probe that never arrived
returned `false`, so the first time the local runtime was closed the agent path went
away for the rest of the session, including after it came back.

RAVIS made the matching change on its side rather than leaving this to be absorbed
here: a pool whose candidates are all in breaker cooldown now answers `503` rather than
`422`, because the pool works again when the cooldown expires and a 4xx would tell
Clarvis it does not.
