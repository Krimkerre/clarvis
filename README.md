# Clarvis

> Clippy's presence. Jarvis's competence. A butler's disdain.

**It can only see the editor window it was born in.**

Clarvis is a sarcastic butler VS Code extension: it activates with a window and dies
with it. No tray icon, no background daemon, no screen reading, no editing your files
on its own initiative. It watches your builds so you don't have to, remembers the
error you keep making, and occasionally judges you for it.

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
answered from Clarvis's own memory (no model call needed), and the M3 walk-away toast
— all in sequence. The panel and avatar are real (§ Avatar states); the task
watching, pattern flagging, and chat surfaces shown here are still on the roadmap
(§ Progress).

## What it does

**Unprompted (the Jarvis half):**
- **Task & build watching** — tracks tasks, terminal commands, and debug sessions;
  notifies on completion with outcome and duration, not just "done." Walk away from a
  build, come back to an answer.
- **Pattern memory** — fingerprints recurring errors per project; on the 3rd occurrence
  in a week, surfaces what fixed it last time. Heuristic, never applied automatically.
- **Session briefing** — on launch: branch + dirty state, what was failing when you
  left, recent files touched, one open pattern-memory item. Four lines, then silence.
- **Dev-moment commentary** — a slow build, a third identical failure, a suite going
  green, a 200-file diff. Rate-limited hard (≤1 unsolicited surface / 10 min); silence
  is the default response.

**On request (the primary interactive surface):**
- **Chat** — the assistant you talk to in this window, replacing the default chat
  panel. Answers from its own watch/memory state need no key or network; harder
  questions go to a model (bring-your-own Anthropic key, or the host's own LM API
  where one exists). Context sent with a question is explicit, bounded, and visible —
  no workspace crawl, no silent file reads.
- **Voice output** *(optional, off by default)* — briefings and completions spoken via
  OS voices, or a Fish Audio voice with your own key.
- **Voice input** *(optional, off by default)* — push-to-talk dictation into the chat
  box, including first-class Flemish Dutch (`nl-BE`) recognition with code-switched
  English jargon. Never auto-sends; the transcript is always editable text.

**Hard rule, enforced architecturally, not by prompt politeness:** Clarvis suggests,
never acts. No file writes, no shell execution, no git operations, ever, uninvited.

Full spec, including every setting, API, and edge case: [`plan.md`](./plan.md).

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
- [ ] **M3 — Task Watching.** Not started. *(First real, ship-worthy-alone value.)*
- [ ] **M4 — Briefing.** Not started.
- [ ] **M5 — Pattern Memory.** Not started.
- [ ] **M6 — Personality Pass.** Not started.
- [ ] **M7 — Chat.** Not started. *(Makes Clarvis the primary agent in the window.)*
- [ ] **M8 — Voice Output.** Not started. *(Stretch — cut without guilt.)*
- [ ] **M9 — Voice Input.** Not started. *(Stretch, independent of M8.)*
- [ ] **M10 — Polish & Release.** Not started.

## Development process

This repo plans and builds itself under a two-mode discipline (`plan.md` §0): a Plan
Mode where only `plan.md` gets touched and every milestone needs explicit sign-off
before any project code is written, and a Code Mode where `plan.md`'s own checklists
get ticked off as each step lands. Branch layout: `main` ← `testing` ← one branch per
milestone (`m0-skeleton`, `m1-event-surface-spike`, …), merged up through `testing`
before reaching `main`.
