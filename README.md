# Clarvis

> Clippy's presence. Jarvis's competence. A butler's disdain.

**It can only see — and only touch — the workspace it was born in.**

Clarvis is a sarcastic butler VS Code extension: it activates with a window and dies
with it. No tray icon, no background daemon, no screen reading. It watches your builds
so you don't have to, remembers the error you keep making, occasionally judges you for
it — and when you ask, it does the work: edits, runs, iterates until the task is done.

The name is a backronym: **C**lippy-**L**ike, **A** **R**ather **V**ery **I**ntelligent
**S**ystem — Clippy's presence, with something closer to Jarvis's competence.

## Avatar states

<img src="media/states-strip.png" alt="Clarvis avatar in its six expression states: Neutral, Judging, Impressed, Thinking, Talking, Surprised" width="100%">

Driven by a single `setState(name)` call — the whole integration surface between the
extension host and the webview. Six states: `neutral`, `judging`, `impressed`,
`thinking`, `talking`, `surprised`. Idle animation (bob, blink) runs autonomously so it
reads as alive, not looping. See [`avatar.html`](./avatar.html) for the live,
interactive version — open it directly in a browser to try every state and read the
quip line under each.

## In action

<img src="media/mockup.png" alt="Mockup of VS Code with Clarvis docked in the sidebar: an editor showing checkout.js with an accidental global variable highlighted, Clarvis in its judging state with the quip &quot;A global variable. Bold. Historic, even.&quot;, a flagged-lines note, a chat thread following up on the flag, and a build-finished toast notification." width="100%">

*Mockup, not a real screenshot* — the fully-revealed end state. For the animated
version — same page, in the same spirit as `avatar.html`: real CSS keyframes, no
recording, no compression — open [`media/mockup-demo.html`](./media/mockup-demo.html)
directly in a browser and watch it play: the buggy line in `checkout.js` highlights,
Clarvis's judging-state quip appears, then a flagged-lines note, a chat follow-up
answered from Clarvis's own memory (no model call needed), and the walk-away
completion toast — all in sequence. The panel, the avatar, and the build-watching
toast are built and working today; the pattern flagging and chat/agent surfaces shown
here are still on the roadmap (§ Progress).

## What it does

**Unprompted (the Jarvis half):**
- **Task & build watching** — tracks tasks, terminal commands, and debug sessions;
  notifies on completion with outcome and duration, not just "done." Walk away from a
  build, come back to an answer.
- **Pattern memory** — fingerprints recurring errors per project; on the 3rd occurrence
  in a week, surfaces what fixed it last time. Heuristic, and never applied on its own —
  it's an unsolicited surface, so it suggests. Reply "go on then" and the agent takes it.
- **Session briefing** — on launch: branch + dirty state, what was failing when you
  left, recent files touched, one open pattern-memory item. Four lines, then silence.
- **Dev-moment commentary** — a slow build, a third identical failure, a suite going
  green, a 200-file diff. Rate-limited hard (≤1 unsolicited surface / 10 min); silence
  is the default response.

**On request (the primary interactive surface):**
- **Chat** — the assistant you talk to in this window, replacing the default chat
  panel. Answers from its own watch/memory state need no key or network; harder
  questions go to a model (bring-your-own Anthropic key, or the host's own LM API
  where one exists). Context sent with a question is explicit, bounded, and visible.
- **Agent** — hand it a real task ("fix the failing test", "rename this everywhere")
  and it edits, runs commands, reads the results, and iterates until it's done. Work
  happens on its own `clarvis/<task>` branch, committed step by step, so your
  uncommitted changes stay yours and the whole run is reviewable — or discardable in
  one command. Every file it touches is listed live with a clickable diff, and it stops
  to ask before anything destructive or outward-facing. Merging and pushing are yours.
- **Voice output** *(optional, off by default)* — briefings and completions spoken via
  OS voices, or a Fish Audio voice with your own key.
- **Voice input** *(optional, off by default)* — push-to-talk dictation into the chat
  box, including first-class Flemish Dutch (`nl-BE`) recognition with code-switched
  English jargon. Never auto-sends; the transcript is always editable text.

Full spec, including every setting, API, and edge case: [`plan.md`](./plan.md).

## Keeping an agent honest

An agent that edits your code is only worth having if getting back out is trivial and
its limits are real. Clarvis's are enforced in the tool layer, not asked for in a
system prompt — a model can't talk its way past code that refuses.

**It acts only when asked.** It will happily rewrite your file; it will never decide on
its own that your file needed rewriting. Everything it notices unprompted comes out as
a remark, not a commit. Ambiguity resolves toward answering — "why is this failing?"
gets you an explanation, not four rewritten files.

**It works somewhere you aren't.** Each task runs on its own `clarvis/<task>` branch,
committing only the paths it touched — never `git add -A` — so your uncommitted work
stays uncommitted and yours. Merging and pushing are your decisions.

**It's undoable in one command.** Every run checkpoints the files it's about to touch.
`Clarvis: Undo Last Agent Run` restores them and puts you back on your branch. Edits go
through VS Code's own edit API, so `Cmd+Z` works normally too. `Clarvis: Stop` aborts at
the next step.

**It stops before the one-way doors.** Destructive shell commands, `git push`,
publishing, and dependency installs all pause and ask. Anything resolving outside the
workspace is refused outright — symlinks included. There is deliberately no setting to
turn gates off; a switch that only half-worked would be worse than none.

**You watch it work.** Every file opened, every file changed, every command run, plus
live step and token counters — in the panel, while it happens, not discovered
afterwards.

**Where git isn't available** — VSCodium ships without the Git extension, and plenty of
folders aren't repos — it says so once and falls back to checkpoint-only. The agent
still works; you still get one-command undo.

## Platform

One `.vsix`, unmodified, on **VS Code** and **VSCodium**. Ships to both the VS Code
Marketplace and Open VSX. (Antigravity and Cursor were evaluated and dropped from
scope — see `plan.md` §1.)

## Progress

Built milestone by milestone against `plan.md`'s own checklist — see that file for
the full per-milestone build notes and exit criteria.

- [x] **M0 — Skeleton.** Extension scaffold, manifest, esbuild bundling,
      activate/deactivate lifecycle. Installs, activates, tears down clean.
- [x] **M1 — Event Surface Spike.** Every §4.0 event source probed against a
      throwaway extension on real VS Code + VSCodium. Key findings: no stable
      third-party test-results API exists (changes M5's design); raw terminal
      commands don't fire task events; debug sessions fire in pairs
      (wrapper + child); Git's change event is a ~5s poll, not reactive; VSCodium
      ships with **no** bundled Git extension; in-webview mic/speech (Tier 0) is
      blocked regardless of OS permission, confirming voice input needs the
      server-side (Tier 1) path.
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
- [ ] **M4 — Briefing.** Not started.
- [ ] **M5 — Pattern Memory.** Not started.
- [ ] **M6 — Personality Pass.** Not started.
- [ ] **M7 — Chat & Agent.** Not started. *(The big one: local answers, then the
      Answer path, then a real agentic harness — tool layer and gates built and tested
      before the model can reach them.)*
- [ ] **M8 — Voice Output.** Not started. *(Stretch — cut without guilt.)*
- [ ] **M9 — Voice Input.** Not started. *(Stretch, independent of M8.)*
- [ ] **M10 — Polish & Release.** Not started.

## Development process

This repo plans and builds itself under a two-mode discipline (`plan.md` §0): a Plan
Mode where only `plan.md` gets touched and every milestone needs explicit sign-off
before any project code is written, and a Code Mode where `plan.md`'s own checklists
get ticked off as each step lands. Scope changes kick back to Plan Mode rather than
growing quietly inside a build. Branch layout: `main` ← `testing` ← one branch per
milestone (`m0-skeleton`, `m1-event-surface-spike`, …), merged up through `testing`
before reaching `main`.

Code follows a documented set of clean-code rules (`plan.md` §0), with one deliberate
deviation: comments are used liberally rather than treated as a last resort, because
this codebase doubles as a worked example. Pure logic is kept in modules that import
nothing from `vscode`, which is what makes it unit-testable without an extension host —
`npm test` runs those against Node's built-in runner, no test framework required.
