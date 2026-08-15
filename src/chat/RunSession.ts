import * as vscode from 'vscode';
import { AvatarController } from '../AvatarController';
import { ModelService } from '../model/ModelService';
import { AgentRunner } from '../agent/AgentRunner';
import { AgentTerminal, runCommand } from '../agent/tools/commandTools';
import { mergeRunBack, reviewRun } from '../agent/reviewWizard';
import { detectTestCommand } from '../agent/testCommand';
import { Busy } from './Busy';
import { offerGitFix } from '../agent/gitOffer';
import { QuipPicker } from '../personality/QuipPicker';
import { matchStep, readStepMarkers } from '../agent/stepProgress';
import { StepExplanation } from '../agent/stepExplanation';
import { PendingChoice } from './PendingChoice';
import { reviewMilestone } from '../agent/readBack';
import { reviewSummary } from '../agent/milestoneReview';
import { Finding } from '../planning/analysisPrompt';

/** The lines a model writes for a run: one to open with, one to close on. */
interface LiveLines {
  acknowledge(task: string): Promise<string | undefined>;
  afterTask(task: string, summary: string): Promise<string | undefined>;
}

/**
 * A task, from "on it" to "what would you like done with it".
 *
 * **The transcript gets what a person would say; the terminal gets everything else.**
 * Tool calls, commands and the model's working-out go to the Clarvis terminal, where a
 * build log belongs — the chat gets the opening line, the result, and the decision. That
 * split was made after a run filled the conversation with ten lines of machine output.
 *
 * The closing offer is the reason this is a session rather than a function call: a run
 * does not end when the model stops, it ends when the user has decided what to do with
 * what it produced.
 */
export class RunSession {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly avatar: AvatarController,
    private readonly models: ModelService,
    private readonly terminal: AgentTerminal,
    private readonly busy: Busy,
    private readonly note: (text: string) => Promise<void>,
    private readonly remark: (text: string) => Promise<void>,
    private readonly phrase: (purpose: 'report' | 'warn' | 'ask' | 'aside', fallback: string, keep?: string[]) => Promise<string>,
    /** Shows where the run has got to. A function rather than the panel itself: this
     * class needs one frame, not a view. */
    private readonly showProgress: (frame: { current: number; total: number; label: string }) => void,
    /** Puts the answers in the panel as buttons. Typing still works regardless. */
    private readonly offer: (items: { label: string; detail?: string }[]) => void,
    private readonly log: (message: string) => void
  ) {
    // The nudge speaks; it does not write. Someone who has not answered is not
    // reading the panel, so another line in the panel is the one thing guaranteed not
    // to reach them.
    this.pending = new PendingChoice(this.offer, (line) => void this.remark(line));
  }

  /**
   * The step-approval question, when one is on screen.
   *
   * **In the chat, not in a modal.** Approval used to be a `showInformationMessage`
   * with `modal: true`, which greys out the editor, cannot be scrolled back to, and
   * puts the one decision that matters somewhere other than the conversation it
   * belongs to. Found live during the first-run checklist.
   */
  private readonly pending: PendingChoice;

  /** Whether a step is waiting on an answer. Chat checks before routing a message. */
  get awaitingStep(): boolean {
    return this.pending.isWaiting;
  }

  /** Hands a typed message to the step waiting for it. */
  answerStep(text: string): void {
    this.pending.supply(text);
  }

  /** The written bank, for the closing aside when no model is available. */
  private readonly closers = new QuipPicker();

  /**
   * The writer for the opening line, once a model exists.
   *
   * Set after construction because the model layer is wired later — and kept optional
   * rather than making the whole session optional, which pushed `?.` into every caller
   * and cost the routing method three branches for nothing.
   */
  private live: LiveLines | undefined;

  setLiveLines(live: LiveLines): void {
    this.live = live;
  }

  /**
   * Hands a task to the agent, streaming its steps into the transcript.
   *
   * The route is **announced before anything starts**, because a misrouted question
   * would otherwise begin editing files with no warning — and the announcement is what
   * makes Stop a real option rather than a theoretical one.
   */
  /**
   * Whether this run stops and asks before each step that acts.
   *
   * Set by the caller from the mode: Agent asks, Auto does not. Auto's whole
   * proposition is deciding for itself, and a mode that asked before every step
   * would be Agent wearing a different label.
   */
  private stepApproval = false;

  /**
   * Whether the mode *currently* asks, checked at each step rather than at the start.
   *
   * **Because a mode change mid-run did nothing.** Set once when the run began, the
   * flag went on asking after someone switched to Unattended precisely to stop being
   * asked — found live, part-way through the second checklist project. Switching is
   * something people do *because* the run is going well and they no longer want to
   * shepherd it; a setting that only applies to the next run is the setting they were
   * not reaching for.
   *
   * Read through a function so the answer comes from the mode as it is now. Note that
   * Auto still asks: `asksFirst` is true for it by design, and Unattended is the one
   * that does not (§4.6).
   */
  private asksNow?: () => boolean;

  /**
   * Lets go of a step question when the mode has just stopped asking.
   *
   * Switching to Unattended is done *because* answering has become the annoyance, and
   * most often while looking at the question that made it one. Leaving that one
   * pending means the switch appears not to have worked — found live on milestone 3,
   * where the mode changed and the button still had to be pressed.
   *
   * Only ever releases a *step* question. The deny-list gate is a different thing and
   * is not a mode setting: `rm -rf` stops and asks in every mode, including this one.
   */
  modeStoppedAsking(): void {
    if (this.asksNow?.() !== false || !this.pending.isWaiting) return;

    this.log('agent: mode no longer asks — releasing the step that was waiting');
    this.pending.supply('Do it');
  }

  setStepApproval(on: boolean, live?: () => boolean): void {
    this.stepApproval = on;
    this.asksNow = live;
  }

  /**
   * The last run that ended by asking something, and what it was doing.
   *
   * **Because answering a question should continue the work, not restart it.** A run
   * that stops to ask "preview, or applied straight away?" now puts that in the chat
   * — and the reply is four words that mean nothing on their own. Without this, they
   * arrive as a fresh task with no memory of the question they answer.
   *
   * Cleared once used: the second message after a run is a new request, not more
   * answer, and treating it as context would drag a finished task through the rest
   * of the conversation.
   */
  private unanswered?: { task: string; question: string };

  /**
   * Whether this run is building an approved plan, rather than a one-off job.
   *
   * Only a plan run has a checklist to tick, and only a plan run has earned the
   * pause: stopping to review after "rename this variable" would be ceremony.
   */
  private fromPlan = false;

  /** The steps this run is working through, for the progress display. */
  private steps: string[] = [];

  /** The run in progress, while there is one. */
  private running?: AgentRunner;

  /**
   * Hands something said mid-run to the agent, rather than answering it separately.
   *
   * **Not a stop.** Stopping and restarting throws away everything read so far, so
   * "no, use the other library" would cost a whole run — and the alternative,
   * answering it in chat while the agent carries on regardless, is worse: the user
   * watches it keep doing the thing they just asked it not to.
   */
  /** Whether a run is under way and can be spoken to. */
  get isRunning(): boolean {
    return this.running !== undefined;
  }

  redirect(text: string): boolean {
    if (!this.running) return false;
    this.running.interject(text);
    return true;
  }

  setFromPlan(on: boolean, steps: string[] = []): void {
    this.fromPlan = on;
    this.steps = steps;
  }

  /** The pending question, folded into a follow-up task. Consumed by reading it. */
  takeUnanswered(): { task: string; question: string } | undefined {
    const pending = this.unanswered;
    this.unanswered = undefined;
    return pending;
  }

  async run(task: string, because: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // **Before anything else.** Asking "shall I run `git init`?" only after a run has
    // already failed to isolate is a worse offer than asking up front — and it is the
    // reason the offer never fired at all: nothing outside `begin()` ever checked, and
    // `begin()` only runs once a task is already under way.
    await offerGitFix(this.context, root, this.log);

    // Written for this job rather than the same sentence every time. It is the first
    // thing said in every run, which makes it the most repeated line in the product.
    const opening = (await this.live?.acknowledge(task)) ?? because;

    // Written, not spoken. The user asked for one line of a run to be read aloud, and
    // that line is the result — "right, on it" is not news.
    await this.note(opening);
    this.avatar.setState('thinking', 'chat');

    const controller = this.busy.start('reply');

    const runner = new AgentRunner(
      this.context,
      root,
      this.models,
      this.terminal,
      this.log,
      // **Always handed over, decided per step.** Passing `undefined` here for a run
      // that started in Unattended would freeze that choice for the whole run, which
      // is the bug this replaced — `askStep` answers immediately when the mode says
      // not to ask, so the decision is made at the step rather than at the start.
      (step) => this.askStep(step)
    );
    // Held for the length of the run, so anything typed while it works has somewhere
    // to go. Cleared in the finally: a redirect handed to a finished run vanishes.
    this.running = runner;


    // Held for the whole run, so a build finishing three seconds in cannot wipe the
    // expression of work the user is watching happen (M8e2).
    const holdingFace = this.avatar.claim('agent');
    this.avatar.setState('thinking', 'agent');

    // A single line while it works. Without it the panel sits silent for a minute and
    // the only signal is the avatar — but it is one line, not a running commentary.
    await this.note(await this.phrase('report', 'Working on it…'));

    // **Nothing technical reaches the transcript.** Tool calls, commands and the
    // model's own working-out all go to the Clarvis terminal, where a build log
    // belongs. The chat gets what a person would say: the result, and an aside.
    this.terminal.announce(`clarvis: ${task}`);

    // What the run ended up saying, which is the only part the chat gets.
    let summary = '';
    // Where it left them — kept apart from the summary, because a note about branches
    // is not the run having said something.
    let closing = '';

    try {
      for await (const event of runner.run(task, controller.signal)) {
        if (!event.text) continue;
        if (event.kind === 'done') {
          summary = event.text.trim();
          closing = event.closing ?? '';
        }

        // Step announcements are for the panel, not for reading: pulled out here so
        // they never reach the terminal as stray "STEP:" lines. An event that was
        // nothing but an announcement has nothing left to show.
        const text = this.takeStepMarkers(event);
        if (text === undefined) continue;

        // Everything, verbatim, in the place that is meant to be read line by line.
        this.terminal.write(
          event.kind === 'tool' ? `\r\n· ${event.detail ?? event.text}\r\n` : text
        );

        // The one exception to "nothing technical reaches the chat": isolation could
        // not be set up, and the reason — a folder that is not a repository, git
        // missing, the extension disabled — is not machine noise, it is the thing the
        // user needs told. This was going to the terminal alone and nowhere else, so a
        // non-repo folder produced no message and no offer at all.
        if (event.toChat) await this.note(event.text);
      }
    } finally {
      this.busy.finish();
      this.running = undefined;
      this.avatar.setState('neutral', 'agent');
      holdingFace();
      // A bar left at "step 3 of 5" after the run ends describes a run that is no
      // longer happening. Cleared here rather than on success, so a stopped or
      // failed run clears it too.
      this.showProgress({ current: 0, total: 0, label: '' });
    }

    const { commits, files } = runner.result;
    await this.close(task, summary, files.length, closing);

    await vscode.commands.executeCommand('clarvis.checkBranchFlow');

    if (files.length > 0) await this.offerReview(commits, files);
  }

  /**
   * The event's text with any step announcement removed, or `undefined` when the
   * announcement was all there was.
   */
  private takeStepMarkers(event: { kind: string; text: string }): string | undefined {
    if (event.kind !== 'text' || this.steps.length === 0) return event.text;

    const progress = readStepMarkers(event.text);
    for (const announced of progress.announced) this.showStep(announced);
    return progress.text.trim() ? progress.text : undefined;
  }

  /**
   * Moves the progress display to the step just announced.
   *
   * An announcement matching no planned step is ignored rather than counted: the bar
   * holding still is a smaller lie than the bar pointing at the wrong step.
   */
  private showStep(announced: string): void {
    const index = matchStep(announced, this.steps);
    if (index === undefined) {
      this.log(`agent: announced a step that matches none in the plan — "${announced}"`);
      return;
    }

    this.log(`agent: step ${index + 1} of ${this.steps.length} — ${this.steps[index]}`);
    this.showProgress({ current: index + 1, total: this.steps.length, label: this.steps[index] });
  }

  /**
   * The moment after a milestone: what changed, and whether to write it down.
   *
   * Offered rather than done silently. The plan is the user's document, and a tool
   * that edits it on its own behalf — recording its own work as complete, on its own
   * say-so — is exactly the thing sign-off exists to prevent.
   */
  private async settleMilestone(summary: string, changed: number): Promise<void> {
    const answer = await vscode.window.showInformationMessage(
      `Milestone finished — ${changed} file(s) changed.`,
      {
        modal: true,
        detail: `${summary}\n\nShall I mark off what's done in plan.md and record what the checks produced?`,
      },
      'Update the plan',
      'Leave it'
    );

    if (answer !== 'Update the plan') {
      this.log('agent: milestone finished, plan left untouched');
      return;
    }

    // Recording it also reports what is left, which is what makes the next milestone
    // a decision rather than a thing you have to remember to go and look for.
    await vscode.commands.executeCommand('clarvis.recordMilestone', summary);

    // **And then he reads his own code back.** The plan gets analysed before a line is
    // written; nothing looked at what was written afterwards, so a milestone was
    // finished on the strength of its own checks passing. Found by reading a finished
    // project by hand: "Chance of rain: 0%", always, past five checks that asked only
    // whether output appeared.
    await this.readBackWhatIWrote(summary);
  }

  /**
   * Reviews the milestone's own diff, and offers what to do about it.
   *
   * Offered, never applied — rule 3 holds at the end of a build exactly as it does at
   * the start of one. Writing the findings into the plan is the option worth having:
   * they become a milestone like any other, with steps and checks, rather than a list
   * in a transcript that scrolls away.
   */
  private async readBackWhatIWrote(summary: string): Promise<void> {
    const findings = await reviewMilestone(this.models, summary, this.log);
    if (findings.length === 0) return;

    await this.note(reviewSummary(findings));
    await this.note(findings.map((finding) => `- **[${finding.class}]** ${finding.what}`).join('\n'));

    this.reviewFindings = findings;
    this.offer([
      { label: 'Fix them now', detail: 'A run that does nothing else, before the next milestone' },
      { label: 'Add to the plan', detail: 'A milestone of their own, to build when you choose' },
      { label: 'Leave them', detail: 'Recorded in the log and nowhere else' },
    ]);
  }

  /** Findings waiting on an answer about what to do with them. Read once. */
  private reviewFindings?: Finding[];

  get hasReviewFindings(): boolean {
    return this.reviewFindings !== undefined;
  }

  takeReviewFindings(): Finding[] | undefined {
    const findings = this.reviewFindings;
    this.reviewFindings = undefined;
    return findings;
  }

  /**
   * Describes one step and waits for a yes.
   *
   * Modal, and deliberately: the run is stopped until it is answered, and a toast
   * that timed out would either strand the run or, worse, be treated as consent.
   * "Skip this step" rather than "No", because the run continues either way — the
   * model is told what was declined and asked to find another route.
   */
  private async askStep(step: StepExplanation): Promise<boolean> {
    // Switching to Unattended mid-run means the *next* step stops asking, not the
    // next run. Falls back to the flag the run started with when nothing live was
    // supplied — the command-palette path has no mode button to read.
    if (!(this.asksNow?.() ?? this.stepApproval)) return true;

    // Written, never spoken. The step title is short and the question is solicited,
    // but a run has a dozen of these in it and hearing each one read aloud is how a
    // voice gets switched off (§4.4's rationing, applied to the surface that would
    // break it fastest).
    await this.note([step.title, '', step.what, ...(step.exact ? ['', step.exact] : [])].join('\n'));

    const answer = await this.pending.ask(
      [{ label: 'Do it' }, { label: 'Skip this step' }],
      // What the nudge will be about, if it comes to that. The step title rather than
      // the whole explanation: this gets spoken aloud, and a paragraph read out to
      // someone who has walked away is not a reminder, it is a monologue.
      step.title
    );

    // No answer means the run was stopped or the panel went away — not consent.
    return answer === 'Do it';
  }

  /**
   * The result, and then the exhale.
   *
   * **Both of these were lost and neither was noticed.** The closing line — where the
   * run left you, and that your own branch is untouched — went to the terminal only,
   * while the comment above this loop claimed the chat got it. The aside disappeared in
   * the commit that stripped machine talk from the transcript: it depended on a variable
   * that rework removed, so a feature asked for two messages earlier went with it.
   *
   * They stay separate, which is the point of having both. The summary is information
   * and has to be trustworthy; the aside is comic relief after it. A summary trying to
   * be funny is a summary nobody can rely on.
   */
  private async close(task: string, summary: string, changed: number, closing = ''): Promise<void> {
    // **A run that changed nothing still ends.** There is no closing line in that case —
    // "your own work is untouched" is meaningless when nothing was touched at all — so
    // the chat went quiet after "Working on it…" and stayed that way. Silence is how a
    // crash looks, and this is the shape of a run that was refused, or that read a file
    // and correctly declined to act on it.
    // **"Nothing needed changing" was a claim, and it was false.** Found live: the
    // model stopped after reading two files and returned no summary at all, and this
    // line reported it as a finding — rewritten in his voice into "The code was
    // already doing what you wanted", about a project whose only file the user had
    // just deleted. A run that ends with nothing to say has established that *he
    // did nothing*, not that nothing needed doing, and the difference is the whole
    // of §2.2's no-invented-facts rule.
    const said =
      summary ||
      (changed === 0
        ? await this.phrase('report', 'I stopped without changing anything, and without saying why. Ask me again if that was not what you wanted.')
        : '');
    if (!said && !closing) return;

    // The branch note goes after whatever was said, and never instead of it. Joined
    // upstream it counted as a summary, so a run that narrated nothing looked like a
    // run that had reported — and the honest line above never fired.
    await this.note([said, closing].filter(Boolean).join('\n\n'));

    // A run that ended on a question is waiting for an answer, and the next message
    // is almost certainly it.
    this.unanswered = said.includes('?') ? { task, question: said } : undefined;

    // **The pause after a milestone.** §0 says the plan becomes a live checklist in
    // Code Mode, ticked as each step lands — which had never been implemented, so a
    // plan approved on Monday still read as entirely unbuilt on Friday. A run that
    // came from a plan stops here, shows what it changed, and offers to write that
    // back before anything else happens.
    if (this.fromPlan && changed > 0) await this.settleMilestone(said, changed);

    const aside = (await this.live?.afterTask(task, said)) ?? this.closers.pick('taskDone')?.text;
    if (aside) await this.note(aside);
  }

  /**
   * The close of a run: what changed, what the options are, and the user chooses.
   *
   * Offered rather than forced — a modal after every run would be its own nuisance —
   * and only when something changed, because a run that touched nothing has nothing to
   * merge, keep or throw away and offering anyway is a dialog about an absence.
   */
  private async offerReview(commits: string[], files: string[]): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // The close of a run is a decision, not an announcement: what changed, what the
    // options are, and the user chooses. Offered rather than forced — a modal after
    // every run would be its own nuisance.
    // Only when there is something to review. A run that changed nothing has nothing
    // to merge, keep or throw away, and offering anyway is a dialog about an absence.
    // The likely answer first, and the *useful* one first of all: a change nobody
    // has run is a change nobody knows about. Offering to check it before offering
    // to keep it is the order a careful person would work in.
    const testCommand = await detectTestCommand(root);

    const answer = await vscode.window.showInformationMessage(
      await this.phrase(
        'report',
        `${files.length} file${files.length === 1 ? '' : 's'} changed, on a temp branch.`,
        [String(files.length)]
      ),
      ...(testCommand ? ['Check it works'] : []),
      'Keep it',
      'Show me first'
    );

    const base = this.context.workspaceState.get<string>('clarvis.agent.baseBranch');

    if (answer === 'Check it works' && testCommand) {
      const passed = await this.checkItWorks(testCommand);

      // Pass or fail, the next offer follows from the result rather than repeating
      // the same menu — that is the whole point of having run it.
      const next = passed
        ? await vscode.window.showInformationMessage(
            await this.phrase('report', 'The tests pass.'),
            'Keep it',
            'Show me first'
          )
        : await vscode.window.showWarningMessage(
            "Clarvis: tests fail. That may be my doing, or it may have been failing already.",
            'Show me first',
            'Bin it'
          );

      if (next === 'Keep it') {
        await mergeRunBack(commits, files, this.log, base, (text) => void this.remark(text));
        return;
      }
      if (next === 'Bin it' || next === 'Show me first') {
        await reviewRun(commits, files, this.log, base, (text) => void this.remark(text));
      }
      return;
    }

    if (answer === 'Keep it') {
      await mergeRunBack(commits, files, this.log, base, (text) => void this.remark(text));
      return;
    }

    if (answer === 'Show me first') {
      await reviewRun(commits, files, this.log, base, (text) => void this.remark(text));
    }
  }

  /**
   * Runs the project's own tests and says how it went.
   *
   * In the same terminal the agent uses, so it reads as one continuous session rather
   * than a second thing happening somewhere else. The result is reported in the
   * transcript either way — a check whose outcome you have to go looking for is not
   * much of a check.
   */
  private async checkItWorks(command: string): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    await this.remark(`Running ${command} to see if it still works.`);

    this.terminal.announce(command);
    const result = await runCommand(root, command, (chunk) => this.terminal.write(chunk));

    const passed = result.exitCode === 0;
    this.log(`check: "${command}" exited ${result.exitCode}`);

    await this.note(
      passed
        ? `\`${command}\` passed.`
        : `\`${command}\` failed — exit ${result.exitCode ?? 'killed'}. The output is in the Clarvis terminal.`
    );

    return passed;
  }
}
