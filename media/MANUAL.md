# Clarvis — the manual

*A sarcastic butler for your editor. Watches your builds, answers questions about your
project, and — once the agent lands — does the work.*

---

## Quickstart

1. **Open the panel.** Click the bowtie in the activity bar. Avatar on top,
   conversation in the middle, prompt at the bottom.
2. **Ask something.** `what's broken?` · `what branch am I on?` · `how long did that
   take?` · `have we seen this before?` — these need **no API key and no network**.
   They're answered from what Clarvis has actually watched happen in this project.
3. **Run a build.** Walk away. When it finishes, Clarvis tells you what happened and
   how long it took — and remembers what was failing when you closed the window.
4. **Turn on the voice** (optional) — type `change voice`, or see *Voice* below.

That's it. Everything else is opt-in.

---

## Talking to Clarvis

Type in the box at the bottom. **Enter** sends, **Shift+Enter** makes a new line.

**Slash commands** — the fast path:

| Command | What it does |
|---|---|
| `/help` | Opens this manual |
| `/voice` | Choose the voice |
| `/engine` | Choose the speech engine |
| `/key` | Set your Fish Audio key |
| `/clearkey` | Remove the stored key |
| `/testvoice` | Say a line, so you can hear it |
| `/cache` | Open the folder of saved audio |
| `/mute` | Silence him (or bring him back) |
| `/clear` | Delete this conversation |
| `/history` | Read earlier conversations |
| `/settings` | Open every Clarvis setting |
| `/model` | Choose models, providers and keys |

**Plain English works too.** "Change the voice", "mute", "show me earlier chats", and
"open the settings" all do the obvious thing. Asking a *question* — "what voice are you
using?" — gets you an answer instead of a dialog, which is usually what you wanted.

**The buttons above the prompt** do the three most common things: **History**,
**Clear**, **Mute**.

---

## What Clarvis does on his own

He talks unprompted in four situations, and never more than **once a minute** in total
— it's one shared budget across everything below, not one each. Things you need to know
now (a build going red, an error you've hit before) get a shorter floor, so good news
can't crowd out bad.

- **When something finishes.** A build, a test run, a debug session — what happened and
  how long it took. Short commands are ignored; nobody needs a notification for a
  two-second script. *(Threshold: `clarvis.watch.minDurationSeconds`.)*
- **When you open a window.** A short briefing: which branch, how much is uncommitted,
  what was failing when you left, what you last touched. Nothing worth reporting means
  nothing is said.
- **When an error repeats.** The third time the same error catches you in a week, he
  mentions it — and what fixed it last time, if he saw a fix. It's a suggestion. He
  won't act on it unless you ask.
- **Dev-moment commentary.** A slow build, a suite going green, an enormous diff. This
  is the part that's there for fun, and it's the first thing the budget suppresses.

Everything he says lands in the chat transcript too, so a notification you missed is
still there to scroll back to.

---

## Models

`/model` opens everything: providers, models, and keys.

**Two models, on purpose.** Chat and coding are configured separately, and the coding
one follows chat until you say otherwise:

| | Used for | Why you'd change it |
|---|---|---|
| **Chat model** | Every question you ask | Every reply costs this one. A small or local model is fine here. |
| **Coding model** | Writing code, running the agent | Needs to hold a tool loop together. This is where the capable model earns its price. |

A cheap model for talking and a capable one for code is the whole point — asking "which
branch am I on?" shouldn't cost frontier prices. The provider can differ too, so a local
Ollama model can answer questions while a hosted one writes the code.

**Providers:** Anthropic, OpenAI, OpenRouter, Ollama and LM Studio. **Keys are kept per
provider**, so switching between them is one click, not a re-entry. They live in your OS
keychain — never in a settings file, never in the log.

**Model lists come from the provider, live.** They're filtered to models that can
actually do the job — on OpenRouter that means only ones that can call tools, which is
about 330 of 400 — and cached for a day. **Refresh** sits inside the picker for when a
provider adds something new. Nothing is hardcoded, so a model released tomorrow appears
without updating this extension.

**Local models need no key at all.** Point Clarvis at Ollama or LM Studio and nothing
leaves your machine.

**No "sign in with Claude."** Anthropic doesn't permit third-party products to use
claude.ai logins or subscription limits without prior approval. Bring an API key.

## Voice

**Off until you turn it on** — a voice that surprises you once is a voice you disable
forever. Clarvis offers to set it up once, on first run, and never brings it up again.

**Turning it on:** add a key with `/key` and voice switches on by itself. No key? The
system voice works with `/settings` → **Clarvis › Voice: Enabled**; it reads the words
but doesn't perform them.

**Two ways to stop him**, and they differ: **Mute** (the button by the prompt, or
`/mute`) silences him instantly, mid-sentence, until you reload the window. Unticking
the setting keeps him quiet for good.

**Two tiers.** Your operating system's built-in voice is free, offline, and always
available; it reads the words but doesn't perform them. [Fish Audio](https://fish.audio)
is the good one, and needs a key of your own.

| I want to… | Do this |
|---|---|
| Pick a voice | `/voice` — highlight a row to hear it before choosing |
| Use my own Fish Audio voice | `/voice` → **Paste a Fish Audio voice ID**, then give it a name to keep it |
| Add my Fish Audio key | `/key` — stored in your OS keychain, never in settings, never logged |
| Change quality vs. cost | `/engine` — defaults to `s2.1-pro-free`, their best model on a free tier |
| Hear a test line | `/testvoice` |
| Silence him right now | **Mute**, or `/mute` — stops him mid-sentence |

**Mute is for the next ten minutes, not forever.** It clears when you reload the
window. To turn voice off properly, use the setting.

**Spoken audio is cached** on disk, so a line you've heard before replays instantly and
costs nothing. `/cache` opens the folder; delete anything in there freely.

**What gets spoken:** everything he says. Briefings, build outcomes, chat replies, the
sardonic asides. How *often* he talks is governed by the once-a-minute budget above —
splitting it would mean the voice carried the dull half of the character and the text
carried the funny half.

---

## Git, without needing to know git

Clarvis uses git to keep your work safe, and tries not to make you learn it.

**`/git`** — *"where am I, and is anything at risk?"* — answered in plain words. What
branch you're on, what's unsaved, whether the shared copy has moved on.

**`switch to <name>`** or **`switch branch`** — changes branch. If you have unsaved
work, Clarvis says what will happen to it *before* moving, and offers to save it where
it is instead.

**Branches, in one paragraph.** A branch is a separate copy of the project's history.
Work done on one doesn't affect the others until you merge it. Clarvis does every task
on its own branch, so if the result is wrong you throw the branch away and nothing of
yours was touched.

**After a task, Clarvis asks what to do with the result** — look at it, merge it, keep
it for later, or bin it. Each option says what it does. If a branch holds work that
exists nowhere else, it says so before deleting anything.

**Nothing here can lose your work without telling you first.** The one thing worth
knowing: changes you haven't saved into git aren't attached to a branch, so they follow
you around until you save them. Clarvis says so whenever it matters.

## Conversations

**Each window starts fresh.** Yesterday's questions were about yesterday's problems.

**Nothing is lost.** The previous conversation is filed automatically when the window
opens — click **History** or type `/history` to read any of the last 20, which open as
an ordinary Markdown tab you can copy from and close.

**Clear deletes.** It asks first, and it does *not* keep a copy in History. That's what
"no undo" means.

---

## Settings worth knowing

`/settings` opens all of them. The ones that matter:

| Setting | Default | What it's for |
|---|---|---|
| `clarvis.voice.enabled` | off | Whether he speaks at all. Mute is the temporary version |
| `clarvis.voice.selectedVoice` | the shipped voice | `system`, or a Fish Audio voice |
| `clarvis.voice.fishAudio.engine` | `s2.1-pro-free` | Quality vs. speed vs. cost |
| `clarvis.voice.savedVoices` | empty | Voices you pasted in and named — edit or delete here |
| `clarvis.voice.dailyRequestCap` | 200 | Stops a runaway bill while you're at lunch |
| `clarvis.watch.minDurationSeconds` | — | Below this, a finished command is ignored |

Settings can be set globally or per project. Clarvis writes to whichever one is already
in use, so a change made in a project stays in that project.

---

## Privacy

- **Your code is never sent anywhere** unless you ask a question that needs a model, and
  then only the context shown to you with the question.
- **Local answers involve no network at all.** No key, no request, no tokens.
- **Keys live in your OS keychain**, never in settings files, never in the log.
- **Everything is per-project** and stays on your machine.

---

## When something's wrong

**"It never says anything."** Check the once-a-minute budget — he may be suppressing.
The **Clarvis** output channel (View → Output → Clarvis) logs every suppression with
its reason.

**"The voice doesn't work."** `/testvoice` and read the output channel. Common causes:
no key set, the daily cap reached, or no audio player on the system.

**"It didn't notice my build."** Commands shorter than the threshold are ignored on
purpose. Also check that terminal shell integration is on — without it, Clarvis can see
that *something* ran but not what it was.

**Anything else** — the output channel is verbose by design and usually names the cause
outright.

---

## Not built yet

Clarvis is under construction, and this manual describes what exists today. Still to
come: the **agent** that does the work, **project planning** from a one-sentence idea,
**voice input**, and **Tutor Mode** for people learning to program. See the README for
progress.
