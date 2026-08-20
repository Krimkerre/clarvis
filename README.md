# Clarvis

> Clippy's presence. Jarvis's competence. A butler's disdain.

**He works in the project folder you opened him in, and cannot change anything
outside it — not with the file tools, and not with the commands he runs.**

Clarvis is a sarcastic butler who lives in your code editor. He watches your builds so
you don't have to, remembers the mistake you keep making, occasionally judges you for
it — and when you ask, he does the work: writes the code, runs it, and keeps going
until the job is done.

He starts when you open a window and stops when you close it. Nothing runs in the
background, nothing sits in your menu bar, and he cannot see your screen or any other
window.

**One thing worth being precise about.** Clarvis's own tools — reading, editing,
searching — never leave the workspace folder, and nothing he writes can land outside it.
A *command* he runs, with your approval, has the same reach any command in your own
terminal would: it can read files the toolchain needs and reach the network. It still
cannot write outside the workspace or its build caches — that's enforced by the
operating system, not by asking nicely. "Can't touch anything outside the project" is
true. "Can't see anything outside the project" is only true of Clarvis himself, not of
what he runs on your behalf.

The name is an acronym nobody needed: **C**lippy-**L**ike, **A** **R**ather **V**ery
**I**ntelligent **S**ystem.

## Documentation

Everything written about this project, and which one you want.

| Document | What's in it | Read it when |
|---|---|---|
| **[plan.md](./plan.md)** | The spec, and the only normative one. Concept, personality rules, every feature (§4), the milestone table and its exit checklists (§7), success criteria (§9), and the codebase measured (§11). 4,286 lines. | You need to know what Clarvis is *meant* to do — or **what is actually built**, which §7 alone decides. |
| **[docs/risks.md](./docs/risks.md)** | The risk register: what could go wrong with Clarvis as a product, and what is already done about each one. Was `plan.md` §8. | You are weighing whether a concern is known, or already answered. |
| **[docs/future-features.md](./docs/future-features.md)** | What is deliberately *not* in v1, and why. A decision record rather than a second spec — each entry points at the `plan.md` milestone that defines it. | You are wondering whether something outstanding is a release blocker or a later feature. |
| **[docs/benchmarks.md](./docs/benchmarks.md)** | Which local models actually work, measured rather than guessed — speed against the deadlines that matter, tool-call reliability, and a free pre-download screen that rejects models unable to drive the agent loop. | You are choosing a model to run on your own machine. |
| **[docs/verification.md](./docs/verification.md)** | The checks still outstanding — the ones needing a real editor, a real provider or a real OS, so they cannot be unit tests. Was `plan.md` §10. | You are about to release, or want to know what is genuinely unproven. |
| **[docs/CURRENT_STATE.md](./docs/CURRENT_STATE.md)** | A live snapshot: what's built, the architecture map with line counts, the safety model, the complexity budget, and how to verify a change. A map of the two big files, not a replacement for them. | You are picking this project up and want to be useful in five minutes. **Start here.** |
| **[docs/build-log.md](./docs/build-log.md)** | Chronological history — every defect found by *using* the product, and why each fix looks the way it does. History, not spec. | You want to know **why** a decision was made, and whether the obvious alternative was already tried. |
| **[AGENTS.md](./AGENTS.md)** | The working rules for any coding agent touching this repo — Plan Mode vs Code Mode, the sign-off gate, the checks to run before shipping. A short, tool-agnostic version of `plan.md` §0. | You are an agent, or you are pointing one at this repo. It stays at the root because that is where agents look for it. |
| **[media/MANUAL.md](./media/MANUAL.md)** | The in-product manual — what a user can actually ask for, every slash command, every mode. This is what `/help` opens. | You are *using* Clarvis rather than building it. It lives in `media/` because it ships inside the extension and is read at runtime. |
| **[docs/TUTOR-README.md](./docs/TUTOR-README.md)** | Design notes for Tutor Mode (M12) — the same Clarvis, teaching as it builds. Not built yet. | You are interested in the teaching mode, or about to build it. |
| **[README.md](./README.md)** | This file: the pitch, the feature list, and the milestone progress list. | You are deciding whether you care. |

If two of these disagree, `plan.md` wins and the other one is stale — that has happened,
and it is why each of them now says so out loud.

## Avatar states

<img src="media/states-strip.png" alt="Clarvis avatar in its six expression states: Neutral, Judging, Impressed, Thinking, Talking, Surprised" width="100%">

He has a face, and it reacts to what's actually happening — mild contempt at a global
variable, genuine approval at something neat, alarm at "I force-pushed to main".
Builds and tests move it, agent runs move it, and so does the tone of whatever he's
about to say.

Six expressions: `neutral`, `judging`, `impressed`, `thinking`, `talking`,
`surprised`. Between them he bobs and blinks on his own, so an idle avatar reads as
someone waiting rather than a paused animation.

Everything the extension host can say to the webview about the face is one
`setState(name)` call — deliberately the narrowest surface the two sides could agree
on.

Open [`avatar.html`](./avatar.html) in a browser for the live version: every state,
with the quip line under each.

## In action

<img src="media/planning.png" alt="VS Code with Clarvis docked in the sidebar: the user answered 'I don't know yet' to what they are building, and Clarvis has replied 'Fine. Here are four. Two of them I am even serious about.' followed by four clickable idea cards — Rent Judge, Relative Recall, The Sourdough Prosecutor, Commute Amnesia — each with a sentence on what it actually does, plus a 'Something else...' option. The mode toggle reads Plan." width="100%">

*A real screenshot.* Plan mode, in the chat panel, on a project with no `plan.md` yet.
The user said they didn't know what to build; the ideas are written for the moment
rather than drawn from a list, which is why they are not four puns about git. Every
option is a button carrying its own explanation, and typing works just as well.

Note the mode toggle: starting an interview switches to **Plan** by itself and back
when it finishes, because §0's rule is that nothing but `plan.md` gets written until
the plan is signed off — and a rule the code knows should be one the interface shows.

## What it does

### Things he does without being asked
- **He watches things run.** Builds, tests, scripts, anything you start in the
  terminal. When it finishes he tells you whether it worked and how long it took — so
  you can walk away and come back to an answer rather than a wall of output.
- **He remembers the error you keep hitting.** The third time the same failure catches
  you in a week, he mentions it, and what fixed it last time. It's a suggestion, not an
  action: say "go on then" and he'll do something about it.
- **He tells you where you left off.** Open a window and you get a few lines: what was
  failing when you closed it, what you were last editing, anything still unfinished. If
  there's nothing worth saying, he says nothing.
- **He has opinions about your day.** A build that's taking forever, a test suite that
  finally passes, a change touching two hundred files. This is the part that's there
  for fun, and it's strictly rationed — **at most one unprompted remark a minute**,
  across everything above. Silence is the default. Bad news gets through faster than
  good, so a passing test can't drown out a broken build.

### Things you ask him for
- **Planning a project.** Turn up with one sentence — "an app that renames my photos
  by the date they were taken" — or with nothing at all. Say you don't know and he'll
  suggest a few ideas, at least two of them genuinely funny.

  He reads what's already in your folder before asking anything, so the questions are
  about *your* project rather than a blank page. Answer vaguely and he pushes back —
  **once** — with one specific question. "I don't know yet" is a real answer: it gets
  written down as an open question instead of argued with.

  Then he tells you what's wrong with your idea. Things that could lose your data,
  two decisions that contradict each other, work that's quietly much bigger than you
  think. You decide on each one, and if you disagree, **your reasoning is written
  down** so nobody re-opens it in a month.

  What you end up with is a plan file: the project broken into milestones, each with
  real steps you can tick off, and each step carrying the test that proves it works.
  Approve it and he builds one milestone at a time — showing you exactly what he's
  about to do first, then stopping when it's done to tell you what changed and what
  the tests said.
- **Talking to him.** A panel in your editor: his face on top, the conversation
  below, a box to type in at the bottom.

  **A lot of what you'll ask costs nothing at all.** "What's broken?", "how long did
  that take?", "have we hit this before?" — he answers those from what he watched
  happen, with no account, no internet and no bill. Harder questions go to whichever
  AI service you've connected (see *Models* below), and you can always see what's
  being sent with them.

  Everything he says on his own lands in the conversation too, so a notification you
  missed is still there to scroll back to. Each window starts fresh; older
  conversations are one click away under **History**. **Mute** sits next to the box
  and stops him mid-sentence — for the next ten minutes, not forever.

  **Type `/help` for the manual.** There are shortcuts for the common things
  (`/plan`, `/voice`, `/mute`, `/history`, `/clear`, `/settings`), but plain English
  works just as well: *"change the voice"*, *"shut up"*, *"show me earlier chats"*.
  Ask a **question** rather than giving an order — *"what voice are you using?"* — and
  you get an answer instead of a settings dialog.
- **Doing the actual work.** Give him a real job — "fix the failing test", "rename
  this everywhere" — and he writes the code, runs it, reads what happened, and keeps
  going until it's done.

  You watch it happen. Files open as he writes them, scrolled to the bit that
  changed, and everything he touches is listed as you go. By default he describes each
  step that changes anything and waits for you to say yes — **Unattended** is the one
  mode that doesn't ask, for a job you're happy to walk away from. Type while he's
  working and he takes it as a correction rather than making you wait.

  **Nothing you haven't saved is at risk.** He works on a copy of your project's
  history, kept separate from your own unsaved changes, and the whole thing undoes
  with one command. Whether any of it becomes permanent is your decision, never his.
- **He can speak.** Half the character is in the writing and the other half is in the
  delivery, so he reads things aloud in a voice chosen to match: gravelly, impatient,
  faintly bored of having to explain. Everything he says can be spoken, not just the
  boring half — splitting it would leave the voice reading status updates while the
  text got the jokes.

  It's **off until you turn it on**, because a voice that surprises you once is a
  voice you switch off forever. He offers to set it up exactly once and never brings
  it up again if you say no. Don't like the voice? Paste in a different one — it's a
  normal option, not buried in advanced settings — and give it a name to keep it. How
  *often* he speaks is governed by the same one-a-minute limit as everything else.
  **Mute** stops him mid-sentence; the setting turns him off for good.
- **You can speak to him** *(planned — not built yet)* — hold a button and talk
  instead of typing, in English or Flemish Dutch, including the habit of mixing English
  jargon into a Dutch sentence. It will never send on its own: what you said turns into
  text you can edit first. Designed in full in [`plan.md`](./plan.md) §4.7; the only part
  that exists today is a microphone check. Everything else on this list is built and
  installed.

- **Version control, without needing to understand it.** Git is the thing that keeps
  a history of your project, and it is famously unfriendly. Clarvis doesn't talk like
  it. Ask `/git` and you get *"where am I, and is anything at risk?"* in plain words.
  Say "switch to main" and he tells you what will happen to your unsaved work
  **before** moving, then offers to put it somewhere safe.

  After he's done a job he asks what to do with the result — look at it, keep it,
  throw it away — and each option says what it will actually do. He warns you before
  anything would throw away work he didn't write. And he never says *detached HEAD*,
  *unstaged* or *unmerged* at you, because those explain nothing to the person who
  needs them explained.
- **He works with your tools, and doesn't choose them for you.** If your project is
  set up to check its own code for mistakes and that check isn't running, he offers to
  switch it on — once. If your project never chose one, he says nothing: turning up in
  someone else's codebase with opinions about style isn't a butler's job. On a new
  project he asks during planning, where it's a decision rather than a criticism.
- **Tutor Mode** *(planned)* — the same Clarvis, explaining every step, for people
  learning to program on a real project of their own. You choose it when you start a
  project, you can type the code yourself or watch it be typed, and it's built to be
  outgrown. Full guide: [**docs/TUTOR-README.md**](./docs/TUTOR-README.md).

Every setting, decision and edge case is written down in [`plan.md`](./plan.md).

## Models — bring whatever you already have

Clarvis has no AI of his own. You connect him to a service you already have an account
with — or to one running on your own machine — and he uses that. Most of them need an
**API key**: a long password you generate on the provider's website, which lets a
program use your account. Clarvis keeps it in your system keychain, never in a settings
file and never in a log. The aim is that
working with him feels like watching someone competent work: you see each thing he
does as he does it, changed files show up as changes you can read, answers are short,
and you can cut in at any point.

| Service | What you need | Can it do the work? |
|---|---|---|
| Anthropic (Claude) | an API key | yes |
| OpenAI | an API key | yes |
| OpenRouter | an API key | yes |
| LM Studio *(runs on your machine)* | nothing | depends which model |
| Ollama *(runs on your machine)* | nothing | depends which model |
| Anything OpenAI-compatible *(your own server)* | its address | depends which model |

**Running everything on your own machine is a proper option**, not an afterthought.
Point him at LM Studio or Ollama and nothing you write ever leaves your computer. The
last row is for llama.cpp, vLLM, LocalAI or a box on your network — Clarvis asks for the
address when you choose it, rather than shipping a guessed default.

**Chat and the coding work can use different models**, which matters more than it
sounds: the chat role carries the character, the planning interview and the analysis,
while the coding role only runs builds. A capable model on chat and a local one on code
is a sensible pairing; the reverse usually is not.

**There's no "sign in with Claude", on purpose.** Anthropic doesn't allow other
products to use claude.ai logins or subscription limits without permission, so Clarvis
doesn't — and doesn't quietly borrow credentials from anything else on your machine
either. Bring an API key. We checked the rules before building a login button, rather
than after.

**Models that run locally vary a lot** in whether they can operate the editor at all.
Clarvis tests each one and tells you when you need a more capable model, rather than
starting a job it can't finish.

## Keeping an agent honest

Something that edits your code is only worth having if backing out is easy and its
limits are real. Clarvis's limits are enforced in code, not written as instructions to
the AI — an AI can be talked out of an instruction, and cannot be talked past code that
simply refuses.

**He acts only when asked.** He'll happily rewrite your file; he will never decide on
his own that it needed rewriting. Anything he notices by himself comes out as a remark,
not a change. If it's unclear whether you wanted a job done or a question answered, he
answers the question — "why is this failing?" gets you an explanation, not four
rewritten files.

**He works somewhere you aren't.** Each job happens on its own copy of your project's
history, and he only ever records the files he actually touched. Your unsaved work
stays unsaved and yours. Whether any of it becomes part of your project for good is
your decision.

**One command undoes all of it.** Before touching anything he takes a copy of every
file he's about to change — and, before the run starts, of everything your version
history has no copy of yet, since a command he runs could destroy that and nothing
else could give it back. **Undo Last Agent Run** puts them all back and returns you
to where you were. Ordinary undo (`Cmd+Z`) works too, because he edits files the same
way you do. **Stop** halts him at the next step.

**He stops before anything you can't take back — and says why.** Deleting things,
publishing, installing software, sharing your work outwards: all of them pause and ask
first.

The asking matters as much as the stopping. A bare "Approve?" just teaches people to
click Approve without reading, so each one tells you what he's about to run, why that
kind of thing is risky, what could go wrong *this time*, and — the important part —
**whether it can be undone**. Deleting files and publishing your work are dangerous in
completely different ways, and the warnings look different too.

**Reading and writing files is confined to your project folder**, symlinks included —
anything resolving outside it is refused outright. There's deliberately no setting to
switch that off, because a safety feature with an off switch is one that gets switched
off.

**Commands are confined too, by the operating system rather than by reading them.**
Running `npm test` means running a shell, and inspecting a shell command to decide
whether it's safe is a game you lose eventually — `python -c "shutil.rmtree(...)"`
doesn't look like `rm -rf`. So the command runs with reduced authority instead: **it
cannot modify anything outside your project and its build caches.** Not because a list
recognised it, but because the kernel refuses, and the kernel doesn't care which
language asked.

Two honest limits. **Reading is still allowed** — toolchains genuinely need to read
from all over your machine, and blocking that breaks every build — so a command can
still read a file you'd rather it didn't. **The network is still open**, because
`npm install` needs it. Destruction and persistence are stopped; exfiltration is not.

macOS and Linux have the machinery for this. **Windows doesn't**, so there he asks
once per project whether to run commands unconfined, and remembers the answer. Say no
and commands are refused — reading, answering, planning and editing all still work.

**The warnings are written by us, never by the AI.** An AI that has just been reading
your files could be persuaded — by something written *in* those files — to describe a
delete-everything command as perfectly safe. A warning that can be rewritten by the
thing it's warning about is not a warning.

**You watch him work.** Every file opened, every file changed, every command run,
while it happens rather than discovered afterwards. His face tracks it too — thinking
while he works, talking when he's explaining or asking, unimpressed when he gives up —
so a glance at the sidebar tells you where things stand without reading a word.

**If your project has no version history yet**, he offers to set one up rather than
quietly doing without — and tells you what's missing if the tools aren't installed.
Say no and you still get the full one-command undo. He asks once per project and never
again.

## Platform

One install file, unmodified, on **VS Code** and **VSCodium** — published to both of
their extension stores. (Antigravity and Cursor were tried and dropped from scope; the
reasoning is in `plan.md` §1.)

## Progress

Built milestone by milestone against `plan.md`'s own checklist. *This part is the
build log, and it's written for anyone who wants to check the work — it's the one
section that assumes you know the jargon.* Full notes for each milestone are in
[`plan.md`](./plan.md).

**`plan.md` §7 is the authority on what is built.** This list, the manual and
`docs/CURRENT_STATE.md` all restate it, and a claim maintained by hand in four places
drifts — an external review caught exactly that here on 16 Aug, when this checklist
still had M9 unticked while the entry beneath it called the same milestone finished.
If the two disagree, believe §7 and fix this.

- [x] **M0 — Skeleton.** Extension scaffold, manifest, esbuild bundling,
      activate/deactivate lifecycle. Installs, activates, tears down clean.
- [x] **M1 — Event Surface Spike.** Every §4.0 event source probed against a
      throwaway extension on real VS Code + VSCodium. Key findings: no stable
      third-party test-results API exists (changes M5's design); raw terminal
      commands don't fire task events; debug sessions fire in pairs
      (wrapper + child); Git's change event is a ~5s poll, not reactive; in-webview
      mic/speech (Tier 0) is blocked regardless of OS permission, confirming voice
      input needs the server-side (Tier 1) path. One finding was later **retracted as
      wrong** — VSCodium does bundle the Git extension; `--list-extensions` simply
      doesn't show built-ins. Kept in `plan.md` rather than deleted, since it had
      shaped design decisions.
- [x] **M2 — Avatar In A Webview.** Renders live in a real VS Code window via
      `WebviewViewProvider`; `setState()` bridge confirmed end-to-end from a command
      through to the most complex state (`surprised`). A few polish checks (theme
      live-switch, CSP boundary probe, dock-location sanity) are deferred to manual
      verification — GUI scripting in this dev environment proved too unreliable to
      finish blind (see `plan.md` M2 exit checklist for exactly what's left).
- [x] **M3 — Task Watching.** Tracks tasks, terminal commands, and debug sessions;
      notifies on completion with outcome and duration. Verified against a real VS
      Code host, which surfaced two defects the build couldn't: every task
      double-notified (tasks fire terminal events too), and a cancelled task pinned
      Clarvis permanently "busy". Both fixed. Concurrency logic is covered by unit
      tests (`npm test`). One item deferred: behavior with shell integration
      disabled.
- [x] **M4 — Briefing.** On launch: branch and dirty count, the job that was failing
      when you left, and the files you last touched. Caught a design flaw in its own
      spec — recent files were specced session-only, which would have made that line
      permanently empty, since the briefing is read before you've saved anything.
- [x] **M5 — Pattern Memory.** Fingerprints recurring errors from both failed commands
      and compiler diagnostics; on the third occurrence in a week it says what fixed it
      last time. Corrected a second spec flaw: credit for a fix waits for the failing
      command to actually go red→green, rather than blaming whatever ran next.
- [x] **M6 — Personality Pass.** Quip bank with earned-sass gating, no-repeat
      selection, and one shared interruption budget (≤1 unsolicited surface / 10 min)
      that M3's notices and M5's pattern hits now route through too. Caught a bug where
      reopening the window counted as a fresh occurrence of an old error. *Full-day
      dogfood pass still outstanding.*
- [x] **M7 — Voice.** Briefings and completions spoken by a curated Fish Audio voice,
      with the OS voice as fallback and a picker for both voice and engine. Playback
      goes through the OS's headless player rather than the webview, because Chromium
      blocks audio until the panel is clicked — which the launch briefing can never
      satisfy. Rendered speech is cached on disk, so repeats cost nothing.
- [x] **M8 — Chat & Agent.** *Built and safety-verified live: gates, path escape,
      prompt injection, undo, branch isolation, the `git init` offer. Not exhaustively
      verified — ~45 finer-grained checklist items (mute mid-sentence, avatar strobing,
      transcript persistence, Ollama, and others) are still open, most of them better
      suited to the outstanding M6 dogfood pass than to being scripted one at a time. See
      `plan.md`'s M8 section for the honest breakdown.* The chat panel answers from local state with no key or
      network, then from a model when one is configured — five providers, separate
      models for chat and for coding so the cheap one handles talking. A tool layer, a
      deny-list gate, checkpoints and per-run branch isolation were built and tested
      *before* the model could reach them, which is why the gate caught a real `rm` the
      day it shipped. Then the agent loop, routing between answering and acting, and a
      git wizard aimed at people who have never used git.
      Two things were rebuilt mid-milestone after being wrong in use rather than in
      test. **Nothing technical reaches the chat any more** — tool calls and command
      output go to a terminal, and the transcript gets what a person would say.
      And the **personality was rebuilt from the prompt outwards** after it drifted into
      five separate hand-written descriptions and started sounding like a status page;
      `Clarvis: Debug — Voice Check` now reads his lines back through the real prompts
      before a change ships. *(Full notes, including the deviations from spec and why,
      are in `plan.md`.)*
- [x] **M9 — Project Planning.** *Built and usable end to end — the front door:
      interview → analysis → `plan.md` → sign-off → the agent builds it.* It runs **in
      the chat panel**: questions arrive in the transcript, spoken, with the options as
      clickable buttons carrying their own explanations; typing a number or the name
      still works. Say yes to the offer on a project with no `plan.md`, or `/plan`.
      He reads the workspace before asking anything, offers ideas when you don't know
      what to build, suggests names and reacts to the one you pick, and **pushes back
      once** on an answer that is vague or hides a risk — then folds the follow-up into
      one coherent sentence rather than a transcript. Analysis reports safety, logic and
      scope problems you rule on individually. The draft opens in the editor as rendered
      markdown while the approval question stays in the conversation, and nothing is
      written until you approve it. The plan holds **every milestone**, each step
      carrying the check that proves it works — written before the code exists, so it
      tests what was meant rather than describing what got built. The agent builds one
      milestone at a time, asking before each step that changes anything, showing which
      step it is on, opening files as it writes them. It runs the checks, reports what
      actually happened, and the results are written back into `plan.md` — steps ticked
      off, outcomes recorded — before the next milestone is offered. Interruptions
      work: a correction folds into the run, **new scope stops it** and gets written
      into the plan first (§0). Half-finished interviews and part-finished milestones
      are both offered back after a reload.
      The plan also carries a **Conventions** section in your project's own language,
      so the code stays consistent when you come back to it in three months.
      *Not built:* nothing outstanding — the container isolation once listed here was
      answered by the OS-level command sandbox instead (see *Keeping an agent
      honest*), at a fraction of the cost.
- [ ] **M10 — Voice Input.** Not started. *(Stretch, independent of M9.)*
- [ ] **M12 — Tutor Mode.** *(Stretch.)* The same Clarvis, teaching as it builds, for
      people learning to program on a real project of their own. Opt-in per project,
      and designed to be outgrown — see **[docs/TUTOR-README.md](docs/TUTOR-README.md)**.
- [ ] **M11 — Polish & Release.** Not started.

## Development process

This project is built the same way Clarvis makes you build yours (`plan.md` §0). In
**Plan Mode** the only file anyone may edit is the plan itself, and no code gets
written until a milestone is signed off. In **Code Mode** the plan's own checklist gets
ticked off as each step lands. If the work turns out to need something the plan doesn't
cover, it goes back to Plan Mode rather than growing quietly inside the build.

Everything lands on `main`. Milestone branches and a `testing` integration branch were
both tried and dropped on 15 Aug: they had stopped matching how the work actually
happened, which is one continuous line. Agent runs still get a branch of their own for
the length of the run, and merge back.

The code follows a written set of rules (`plan.md` §0), with one deliberate exception:
comments are used liberally rather than sparingly, because this codebase is meant to be
read as a worked example. Anything that can be tested on its own is kept in files that
know nothing about the editor, which is what makes them testable without running the
editor at all — `npm test` runs those with Node's built-in test runner and no
framework, **828 of them**. A further four run inside a real extension host
(`npm run test:host`), covering the handful of things a pure test cannot reach:
activation, command registration, and the workspace boundary against the real API.
Both run on every push through GitHub Actions, along with a packaging check.

`npm run lint` checks how complicated each function is allowed to get, rather than
checking style. It was added after someone reported the project had "too much
complexity" without saying how much — measuring found five functions at or near the
limit, and the useful outcome was turning that into a number the build checks rather
than an opinion to argue about. The limit is stricter than the default, which the two
worst offenders would have passed unchanged. Breaking those up produced the first tests
that part of the code had ever had, which is a better argument for the rule than the
number is.

It keeps earning its place. Six functions currently sit at exactly the limit, so the
next branch added to any of them fails the build — which is the point. The routing
method that decides what a chat message *is* sat there until 16 Aug; splitting it apart
took it to 7 and, again, produced the first tests covering the gate that decides whether
Clarvis is allowed to edit your files at all.

## Special thanks

**[Alexander](https://github.com/alexander-keisse)** — for feedback, guidance and tips
throughout the build. A second pair of eyes on a project like this is worth more than it
sounds: most of what went wrong here went wrong in the gaps between working parts, and
those are exactly the places you stop seeing once you have stared at them long enough.
