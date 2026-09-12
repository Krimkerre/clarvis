import * as vscode from 'vscode';
import { workspaceFolderPath } from '../agent/gitExtension';
import { repositoryForFolder } from '../agent/repositoryForFolder';
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

  /**
   * Whether an agent run is in progress.
   *
   * §4.6 *Personality under load*: quips are suppressed while a task runs. That was
   * only being applied to the *model-written* line — the canned one still announced,
   * so a quip landed in the middle of a run. Suppression belongs to the whole remark,
   * not to how it was produced.
   */
  private busy: () => boolean = () => false;

  setBusySignal(busy: () => boolean): void {
    this.busy = busy;
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

    await this.noticeCommit(repo, repo.state?.HEAD?.commit);
    this.noticeBigDiff(repo.state?.workingTreeChanges?.length ?? 0);
  }

  /**
   * A commit that appeared since the last poll.
   *
   * Only remarked on after a stretch of silence — a commit is not news, and a remark on
   * every one of them would be the wallpaper §5 exists to avoid. The silence is measured
   * from git rather than from this object, because this object starts empty every time
   * the window opens and a gap it cannot measure is a gap the model would invent.
   */
  private async noticeCommit(repo: any, head: string | undefined): Promise<void> {
    if (!head) return;

    if (this.lastKnownHead && head !== this.lastKnownHead) {
      const now = Date.now();
      const quiet = this.lastCommitSeenAt === undefined || now - this.lastCommitSeenAt > COMMIT_SILENCE_MS;

      // A commit Clarvis made is still a commit — it resets the silence — but by the
      // original rule it was not something to congratulate anyone for. That rule is
      // waived at the user's request (§5, amended): him being pleased with his own work
      // is in character.
      if (quiet && !this.ownCommits.has(head)) {
        this.say('firstCommitAfterSilence', 'impressed', await describeSilence(repo));
      }

      this.lastCommitSeenAt = now;
    }

    this.lastKnownHead = head;
  }

  /**
   * A working tree that has grown enormous.
   *
   * Announced once per crossing rather than once per poll — otherwise it repeats every
   * five seconds for as long as the tree stays large, which is precisely how long
   * somebody is least able to do anything about it.
   */
  private noticeBigDiff(dirty: number): void {
    if (dirty < BIG_DIFF_FILES) {
      this.bigDiffAnnounced = false;
      return;
    }

    if (this.bigDiffAnnounced) return;

    this.bigDiffAnnounced = true;
    this.say('bigDiff', 'surprised', `${dirty} files changed at once`);
  }

  private say(
    trigger: QuipTrigger,
    state: Parameters<Announcer['announce']>[1],
    detail?: string
  ): void {
    if (this.busy()) {
      // Not deferred, dropped. A remark about a build that finished four minutes ago,
      // delivered once the run ends, has outlived the moment it was about.
      this.log(`quip ${trigger} suppressed — an agent run is in progress`);
      return;
    }

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

/** This folder's repository, if the Git extension is present and has found it. */
async function currentRepository(): Promise<any | undefined> {
  try {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) return undefined;
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return repositoryForFolder(exports?.getAPI?.(1)?.repositories, workspaceFolderPath());
  } catch {
    return undefined;
  }
}

/**
 * How long it had actually been since the last commit.
 *
 * **Read from git rather than from memory.** The gap was tracked in a field that starts
 * undefined every time the window opens, so on a fresh session there was no number at
 * all — and given no number while being asked for a specific remark, the model supplied
 * one: "radio silence for a fortnight", about a gap nothing had measured.
 *
 * The two most recent commit dates are the truth, and they survive a reload. When even
 * that is unavailable the detail says the gap is unknown, which is worth a sentence:
 * absent facts are exactly where invented ones grow.
 */
async function describeSilence(repo: any): Promise<string> {
  try {
    const commits = await repo.log({ maxEntries: 2 });
    const [latest, previous] = commits ?? [];
    const newer = latest?.authorDate ?? latest?.commitDate;
    const older = previous?.authorDate ?? previous?.commitDate;

    if (!newer || !older) return 'the first commit after a quiet stretch — you do not know how long';

    const days = Math.floor((new Date(newer).getTime() - new Date(older).getTime()) / (24 * 60 * 60 * 1000));
    if (days < 1) return 'the first commit after a quiet stretch, though less than a day of it';

    return `the first commit in ${days} day${days === 1 ? '' : 's'}`;
  } catch {
    return 'the first commit after a quiet stretch — you do not know how long';
  }
}
