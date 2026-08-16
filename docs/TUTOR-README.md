# Tutor Mode

*A guide for anyone deciding whether this is for them — including people who have never
written a line of code.*

> **Status: designed, not built yet.** Tutor Mode is a planned feature (milestone M12).
> Everything below describes what it will do and why it is being built that way. If you
> are reading this to decide whether to wait for it, that is exactly what it is for.
> What already works today is listed in the main [README](../README.md).

---

## First, what is Clarvis?

Clarvis is an assistant that lives inside your code editor (VS Code). It has a small
animated face, a dry sense of humour, and a job.

Three things it does:

**It watches your work.** When a build finishes, a test fails, or you run something
slow, it notices — and tells you when you come back. If the same error has caught you
three times this week, it says so, and what fixed it last time.

**It answers questions about your project.** "What's broken?" "What branch am I on?"
"Have we seen this before?" — asked in plain words, answered from what it has actually
watched happen, not from a guess.

**It builds things.** You describe what you want, it asks questions until the idea is
solid, writes a plan, and then — once you approve — works through that plan. It works
on its own branch, stops and asks before anything it can't undo, and can put everything
back the way it was.

It is a butler, not an oracle. It does what you ask, comments on what it sees, and
occasionally implies you should have known better.

---

## So what is Tutor Mode?

The same Clarvis, teaching instead of just doing.

Regular Clarvis assumes you know what a branch is, why a test failed, and what that
error message meant. Tutor Mode assumes none of it — and explains as it goes, so that
by the end you understand the thing you built rather than just owning it.

**It is for learning by building something real.** Not exercises, not a to-do list app
you throw away — the actual thing you wanted to make. The code is real, the project is
real, and it is yours at the end.

You choose it when you start a new project. Clarvis asks once:

> *Regular — I build, you review, we move quickly.*
> *Tutor — I explain everything as we go, and you can write the code yourself.*

That's the whole decision. It isn't permanent, and it isn't a judgement about you.

---

## How it works

### Planning: questions you can actually answer

Every project starts with a conversation. In Tutor Mode, that conversation changes shape:

- **Questions come with options, and each option says what it costs you.** Not *"what
  database do you want?"* — instead: *"a file on your computer (simplest, works
  offline, no accounts), or a proper database (needed if other people will use it)?"*
  You can answer that on day one. You cannot answer the first version at all.
- **Every question explains why it's being asked**, in one line, before it asks. You
  should never be answering blind.
- **Choosing what to build it in** is a real question, and you get a real answer. Once
  Clarvis knows what you're making, it lays out two or three options with what each is
  actually like — how much you need to learn before something runs, how fiddly the
  setup is, what people normally build with it, and how easy it'll be to find help that
  matches what you're doing. Ask which one it would pick and it tells you, with
  reasons. It's still your call.
- **New words get defined once**, then used normally afterwards — and they pile up in a
  `GLOSSARY.md` file in your project, in the order you met them. Your vocabulary, in
  your own project, re-readable any time.
- **It still argues with you.** If your idea has a hole in it, Clarvis says so. That
  doesn't get switched off for beginners — you just get told *why* it's a hole, instead
  of being told it is one.

It will also push you toward something small enough to *run today*. Not because your
idea is too ambitious, but because watching your own thing work for the first time is
the single best reason to come back tomorrow.

### Building: you pick who holds the keyboard

Once the plan is agreed, you choose how to build — and you can switch any time, mid
project, mid step, no explanation needed:

| | **Hands-on** | **Guided auto** |
|---|---|---|
| Who types the code | You | Clarvis |
| What Clarvis does | Explains what this step needs and why, shows you the shape of it, waits | Writes it, then walks you through every change |
| What happens next | It reads what you actually wrote and tells you what's wrong *and why* | You approve it before it goes anywhere |

Both go one step at a time. Both explain. The only difference is whose hands are moving.

**If you solve it differently, that's fine.** Hands-on review checks whether your code
*works* and whether it will hurt you later — not whether it matches what Clarvis had in
mind. Different is not wrong, and anything that's merely Clarvis's preference gets
labelled as a preference.

### The part a tutorial can't do

Clarvis is watching your real project, which means lessons arrive when they're relevant
rather than when a syllabus says so.

- **You will learn to read errors — from your own errors.** Sometimes Clarvis will say
  *"run it now, it's going to fail, and I want you to read what it says"* — then take
  the error apart with you: which line matters, which two-thirds are noise. Every
  programmer's first solo crisis is an error message nobody explained. This is the fix.
- **Lessons come from what actually happens.** The third time an error catches you is
  when the underlying concept means something. That's when it gets explained.
- **You'll be asked to guess first.** Before it tells you what a line does, it asks what
  you think it does. Being wrong is useful and is treated that way — it shows both of
  you what to fix.
- **Not everything gets explained equally.** Some code is load-bearing, some is
  ceremony that's identical in every project. Clarvis says which is which, so you know
  what's safe to ignore. Permission to *not* understand something is part of learning.
- **Your code comes with the explanations written in.** Every file is commented
  throughout — what this does, why it's here, what would break without it. Regular
  Clarvis asks whether you want that; in Tutor Mode you always get it, because the code
  *is* the lesson and next week you'll be reading it back with nobody to ask. Those
  comments are yours permanently — nothing strips them out when you move on.
- **Git gets explained as it happens, not up front.** Version control is the biggest
  thing here that isn't about your project, and Clarvis uses it constantly — a separate
  branch for every task, a save point for every run. The first time each piece comes
  up, you get three sentences on what it is and what it means for your work: what a
  branch is when one gets made, what a commit is when one lands, what merging does when
  you're offered it. Each explained once, ever — including on your next project, since
  it remembers that you've already met it.
- **You're invited to break things.** *"Change that number and see what happens — I'll
  put it back."* Clarvis takes a snapshot before it touches anything, so experimenting
  costs nothing. Poking at code is how it starts making sense.

---

## What it won't do

Worth stating plainly, because these are the ways this sort of thing usually goes wrong:

**It won't make jokes at your expense.** Clarvis is sarcastic about situations — broken
builds, questionable decisions, its own existence. Never about you not knowing
something. That's a hard rule, not a preference.

**It won't fake an error to teach you.** Every error you learn from is a real one from
your real project. Nothing is deliberately broken to make a lesson.

**It won't lie to make things simple.** Some explanations get simplified — that's normal
and fine. But if the honest answer is genuinely too big for right now, Clarvis says
*"that's a real question and a big one, let's park it"* rather than inventing a neat
answer you'd have to un-learn later.

**It won't make you learn when you're not in the mood.** Say *"just do it for me"* and
it does, with no lecture and no sulking. Frustration is where people quit.

**It won't hide the dangerous bits.** Anything that can't be undone — deleting things,
publishing, installing packages — stops and asks first, and explains *why* it's risky
in words you can act on. Those explanations are some of the most useful teaching in the
whole mode.

**It won't build you a toy.** Same tools, same safety, same real code as everyone else.

---

## Outgrowing it

That's the point.

After a while, you'll start answering your own questions before Clarvis asks. When that
happens it offers — once — to step back into regular mode. Say no and it never asks
again.

**Nothing changes when you switch.** Same editor, same panel, same project, same files,
same history. Nothing gets rebuilt, migrated, or replaced. The project you made while
learning is a real project, and it keeps working exactly as it was.

There's no "beginner edition" to be stranded on and nothing in your code marking it as
training-wheels work. Clone your repository and you couldn't tell which mode built it.

You were using the real tool the whole time. You just had the explanations turned on.

---

## The short version

- Clarvis watches your project, answers questions about it, and builds things with you.
- Tutor Mode is the same Clarvis, explaining every step, on a real project of your own.
- You choose it when you start a project. You can leave whenever you like.
- You can type the code yourself or watch it being typed — either way you get the *why*.
- You'll learn to read errors, because you'll read your own.
- Nothing is a toy, nothing is faked, and nothing is at your expense.

*Not built yet — see the [README](../README.md) for what works today, and
[plan.md](../plan.md) §4.10 for the full design.*
