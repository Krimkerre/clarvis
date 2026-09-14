import { forgetGitOfferDeclined, type OfferMemory } from '../agent/gitOfferMemory';
import type { GitSetupFailure, GitSetupResult } from '../agent/gitSetup';
import { offerAnswer } from './offerAnswer';

/**
 * **Set up git here**: the way forward when Codex refused a task because the folder has no git (plan.md M15, "Codex
 * offers to set git up"; the owner's decision of 14 Sep 2026).
 *
 * **What happened without it.** In a folder without git where the owner had declined Clarvis's `git init` offer
 * earlier, Codex refused the task, the offer stayed silent ("already declined, not asking again"), and "git init then"
 * went to Codex as a brand new task and met the same refusal. A loop with no exit from the chat.
 *
 * **The rules, as the owner set them:**
 * - one click, **Set up git here**, runs `git init` and makes a first commit (`agent/gitSetup.ts`), with one plain
 *   line saying so;
 * - offered **even after an earlier decline**: that "no" was about an optional nicety for Clarvis's own engine, and
 *   Codex strictly needs git. So this never reads the remembered answer; it only forgets it once git is really set up
 *   (see `gitOfferMemory.ts` for why);
 * - typing an answer works like the button: "git init", "set it up", "yes". Anything else typed while it waits is the
 *   message it is, and the offer goes away. A typed answer is never a new task for Codex;
 * - once git is set up, the Codex task the owner asked for carries on, without their typing it again.
 *
 * **What decides whether it is offered at all** lives before this: Workspace Trust and the engine's other refusals
 * stop a Codex task before it gets near git (`engineChoice.ts`), RAVIS says whether Codex may run before any branch
 * (`runCore.beforeStart`), and RAVIS is asked whether it would take this folder at all before the offer is made
 * (`runCore.branchRefused`), so git is never set up in a folder Codex would refuse anyway, a protected repository
 * among them.
 *
 * vscode-free: `RunSession` hands in the chat, the setup and the task.
 */

export const SET_UP_GIT = 'Set up git here';
export const NOT_NOW = 'Not now';

/** The buttons. The detail is the short form of the offer's line, for someone reading only the buttons. */
export function gitSetupChoices(): { label: string; detail?: string }[] {
  return [
    { label: SET_UP_GIT, detail: 'git init and a first commit, then Codex carries on' },
    { label: NOT_NOW, detail: "Nothing changes, and Codex can't start here yet" },
  ];
}

export const CODEX_GIT_LINES = {
  /** Said once, under Codex's refusal, before the buttons: what the button does, plainly. */
  offer:
    'Set up git here runs `git init` and makes a first commit in this folder, then Codex carries on with this task. Your files stay as they are.',
  /** The opening line of the task carried on. */
  carryingOn: 'Git is set up here. Carrying on with the Codex task.',
  /** Git is set up, but the editor's Git extension, which Codex's branch is made through, hasn't seen it yet. */
  notCaughtUp: "Git is set up here, but the editor hasn't caught up with it yet. Ask for the task again in a moment.",
} as const;

/**
 * Words that mean "set it up" to this offer and nothing in general, on top of `offerAnswer`'s shared yes and no.
 * Anchored to the start by `offerAnswer`, so "git init then" is a yes and "why does Codex need git init" is not.
 */
const SET_UP_WORDS = [
  '(run )?git init',
  'init',
  'set (it|git) up',
  'set ?up( git)?',
  'initiali[sz]e( git| it)?',
  'go ahead',
  'make it a (git )?repo(sitory)?',
];

/** The button a typed answer means, or undefined when it isn't an answer to this offer. */
export function gitSetupChoice(typed: string): string | undefined {
  const answer = offerAnswer(typed, SET_UP_WORDS);
  if (answer === 'yes') return SET_UP_GIT;
  return answer === 'no' ? NOT_NOW : undefined;
}

export interface CodexGitSetupHost {
  /** Shows the buttons and waits: the label chosen or typed, or undefined when it went unanswered or was stopped. */
  ask(): Promise<string | undefined>;
  /** Writes a line in the chat. */
  note(line: string): Promise<void>;
  /** `git init` and the first commit, with the editor's checks around it (`gitOffer.setUpGitHere`). */
  setUp(): Promise<GitSetupResult>;
  /** This workspace's remembered answers, for the decline git setup supersedes. */
  memory: OfferMemory;
  /** The refused Codex task, carried on as the owner asked for it. */
  carryOn(): Promise<void>;
  log(line: string): void;
}

/**
 * Failures worth another click: the owner can fix a folder permission or git's name and email and choose the button
 * again. Not a missing git, a Restricted Mode folder or a vanished folder: those need something else done first, and
 * the line says what.
 */
const WORTH_ANOTHER_CLICK: ReadonlySet<GitSetupFailure> = new Set<GitSetupFailure>(['init-failed', 'commit-failed']);

/** The offer, from its line to the task carried on, or to the owner's "not now". */
export async function offerCodexGitSetup(host: CodexGitSetupHost): Promise<void> {
  await host.note(CODEX_GIT_LINES.offer);
  // Bounded by the owner: every pass waits on a click or a typed answer, and ends on anything but Set up git here.
  for (;;) {
    const answer = await host.ask();
    if (answer !== SET_UP_GIT) {
      host.log(`codex git setup: ${answer === NOT_NOW ? 'not now' : 'the offer went unanswered'}, the remembered answer left as it was`);
      return;
    }
    const result = await host.setUp();
    if (result.ok) return settled(host, result);
    await host.note(result.line);
    if (!WORTH_ANOTHER_CLICK.has(result.reason)) return;
  }
}

async function settled(host: CodexGitSetupHost, result: Extract<GitSetupResult, { ok: true }>): Promise<void> {
  // Only now, with git really set up: the earlier "no" to Clarvis's own offer is superseded by this "yes".
  await forgetGitOfferDeclined(host.memory);
  host.log(`codex git setup: git is set up (${result.madeFirstCommit ? 'first commit made' : 'it already had a commit'}), carrying the task on`);
  if (result.editorCaughtUp === false) return host.note(CODEX_GIT_LINES.notCaughtUp);
  await host.carryOn();
}
