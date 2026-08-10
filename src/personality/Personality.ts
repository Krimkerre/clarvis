import * as vscode from 'vscode';
import { BusyTracker, Outcome } from '../watch/BusyTracker';
import { Announcer } from './Announcer';
import { QuipPicker } from './QuipPicker';
import { QuipTrigger } from './quipBank';

/** A build slower than this is worth a remark (§5). */
const SLOW_BUILD_MS = 5 * 60 * 1000;

/** Working-tree size at which a diff stops being a change and becomes an event. */
const BIG_DIFF_FILES = 200;

/** Silence before a commit counts as "it lives" rather than routine. */
const COMMIT_SILENCE_MS = 3 * 24 * 60 * 60 * 1000;

/** Git state is a ~5s poll (M1), so raw change events mean nothing on their own. */
const GIT_POLL_MS = 5000;

/**
 * Watches for the §5 dev moments and remarks on them — through the Announcer, so the
 * interruption budget applies.
 *
 * Everything here is an *observation*. Nothing it notices changes a file or runs a
 * command (rule 3).
 */
export class Personality {
  private readonly picker = new QuipPicker();
  /** Last known exit status per command, for spotting a red→green transition. */
  private readonly lastStatus = new Map<string, 'red' | 'green'>();
  /** Consecutive identical failures, for the repeat-failure trigger. */
  private readonly failureStreak = new Map<string, number>();

  private lastKnownHead: string | undefined;
  private lastCommitSeenAt: number | undefined;
  private bigDiffAnnounced = false;

  /** Writes a line for the moment, when a model is configured. Absent is normal. */
  private live: { write(trigger: QuipTrigger, sharp: boolean, detail?: string): Promise<string | undefined> } | undefined;

  /**
   * Commits Clarvis made himself, which are not news about the user.
   *
   * Seen live: an agent run committed, the git poll noticed a new commit after a quiet
   * stretch, and Clarvis congratulated the user on committing — for work he had just
   * done. Applauding your own commit is the least earned remark this product can make.
   */
  private readonly ownCommits = new Set<string>();

  /** Told by the agent path what it committed, so those commits stay unremarked. */
  noteOwnCommit(hash: string): void {
    this.ownCommits.add(hash);
  }

  /** Lets the composition root supply a model without this class knowing about providers. */
  setLiveQuips(live: { write(trigger: QuipTrigger, sharp: boolean, detail?: string): Promise<string | undefined> }): void {
    this.live = live;
  }

  constructor(
    private readonly announcer: Announcer,
    private readonly log: (message: string) => void
  ) {}

  start(tracker: BusyTracker, context: vscode.ExtensionContext): void {
    tracker.onOutcome((outcome) => this.onOutcome(outcome));
    this.watchGit(context);
  }

  /** Commands finishing: slow builds, repeat failures, and suites going green. */
  private onOutcome(outcome: Outcome): void {
    const succeeded = outcome.exitCode === 0;
    const previous = this.lastStatus.get(outcome.label);
    this.lastStatus.set(outcome.label, succeeded ? 'green' : 'red');

    if (!succeeded) {
      const streak = (this.failureStreak.get(outcome.label) ?? 0) + 1;
      this.failureStreak.set(outcome.label, streak);
      this.picker.noteEvidence(); // a failure is evidence; sass is earned, not granted

      if (streak >= 3) {
        this.say('repeatFailure', 'judging', `"${outcome.label}" has failed ${streak} times in a row`);
        return;
      }
      return;
    }

    this.failureStreak.set(outcome.label, 0);

    // Red → green on the same command is the only honest "it's fixed" signal — the
    // same reasoning M5 uses for crediting a fix.
    if (previous === 'red') {
      this.say('suiteWentGreen', 'impressed', `"${outcome.label}" passes again`);
      return;
    }

    if (outcome.durationMs >= SLOW_BUILD_MS) {
      this.picker.noteEvidence(); // waiting nine minutes counts as a rough session
      this.say('buildSlow', 'judging', `"${outcome.label}" took ${Math.round(outcome.durationMs / 60000)} minutes`);
    }
  }

  /**
   * Polls git state for commits and diff size.
   *
   * M1 established the Git extension's change event fires every ~5s regardless of
   * whether anything changed, so this **diffs against what it last saw** rather than
   * treating the event as a signal. Without that, every one of these would fire
   * constantly.
   */
  private watchGit(context: vscode.ExtensionContext): void {
    const timer = setInterval(() => void this.pollGit(), GIT_POLL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  private async pollGit(): Promise<void> {
    const repo = await currentRepository();
    if (!repo) return;

    const head: string | undefined = repo.state?.HEAD?.commit;
    const dirty: number = repo.state?.workingTreeChanges?.length ?? 0;
    const now = Date.now();

    if (head && this.lastKnownHead && head !== this.lastKnownHead) {
      const quiet = this.lastCommitSeenAt === undefined || now - this.lastCommitSeenAt > COMMIT_SILENCE_MS;

      // A commit Clarvis made is still a commit — it resets the silence — but it is
      // not something to congratulate anyone for.
      if (quiet && !this.ownCommits.has(head)) {
        this.say('firstCommitAfterSilence', 'impressed', 'the first commit in a while');
      }
      this.lastCommitSeenAt = now;
    }
    if (head) this.lastKnownHead = head;

    // Announced once per crossing, not once per poll — otherwise it repeats every 5s
    // for as long as the tree stays large.
    if (dirty >= BIG_DIFF_FILES && !this.bigDiffAnnounced) {
      this.bigDiffAnnounced = true;
      this.say('bigDiff', 'surprised', `${dirty} files changed at once`);
    } else if (dirty < BIG_DIFF_FILES) {
      this.bigDiffAnnounced = false;
    }
  }

  private say(
    trigger: QuipTrigger,
    state: Parameters<Announcer['announce']>[1],
    detail?: string
  ): void {
    const quip = this.picker.pick(trigger);
    if (!quip) return;

    this.log(`quip ${trigger} (${quip.tone}) sass=${this.picker.sassUnlocked}`);

    // The bank is the fallback, not the default. A written line is about *this*
    // commit on *this* branch; the bank has a fixed number of jokes and is therefore
    // a countdown to hearing one twice. The model is only asked once the budget has
    // already agreed to let something through — see Announcer.announceWith.
    void this.announcer.announceWith(
      () => this.live?.write(trigger, this.picker.sassUnlocked, detail) ?? Promise.resolve(undefined),
      quip.text,
      state,
      'quip'
    );
  }
}

/** The first repository, if the Git extension is present and has finished scanning. */
async function currentRepository(): Promise<any | undefined> {
  try {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) return undefined;
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports?.getAPI?.(1)?.repositories?.[0];
  } catch {
    return undefined;
  }
}
