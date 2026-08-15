import * as vscode from 'vscode';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { AvatarController } from '../AvatarController';
import { BusyTracker } from '../watch/BusyTracker';
import type { Pattern } from '../memory/patterns';
import { VoiceService } from '../voice/VoiceService';
import { Transcript } from './Transcript';
import { Busy } from './Busy';
import { Replier } from './Replier';
import { RunSession } from './RunSession';
import { factsBlock, localAnswer } from './localAnswer';
import { WorkspaceFactsReader } from './WorkspaceFactsReader';
import { chatAction, isStopRequest } from './chatCommands';
import { ChatActions } from './ChatActions';
import { ModelService } from '../model/ModelService';
import { isDoItNow, needsClassification, routeFor } from './routing';
import { classifyIntent } from './intentModel';
import { asksFirst, canEdit, ChatMode, modeSpec, PLAN_ADDENDUM, capabilities } from './modes';
import { Voice, opening } from '../personality/Voice';
import { researchWorkspace } from '../planning/workspaceResearch';
import { describeWorkspaceSignals } from '../planning/workspaceSignals';
import { AgentTerminal } from '../agent/tools/commandTools';
import { PlanningChatIO } from './PlanningChatIO';
import { DraftDocument } from '../planning/DraftDocument';
import { acceptGitOffer, declineGitOffer, gitOffer } from '../agent/gitOffer';
import { runPlanning } from '../planning/PlanningFlow';
import { workspaceMemory } from '../planning/workspaceMemory';
import { describeProgress, worthResuming } from '../planning/interviewStore';
import { startupOffer } from './startupOffer';
import { offerAnswer } from './offerAnswer';
import { PendingChoice } from './PendingChoice';

/** Set when someone turns the planning offer down, so it is asked once per project. */
const PLAN_OFFER_DECLINED = 'clarvis.planning.offerDeclined';
import { fixFindingsTask } from '../planning/reviewFollowUp';
import { addFindingsToPlan } from '../planning/recordMilestone';
import { interruptedBuild, PendingBuild } from '../planning/pendingBuild';
import { judgeScope, recordScopeChange } from '../planning/kickback';
import { ScopeVerdict } from '../planning/scopeChange';
import { nextMilestoneTask } from '../planning/nextMilestoneTask';


/**
 * The chat panel's coordinator: what a message is, and who deals with it.
 *
 * Almost nothing happens here. A message is a stop, an action, a job, or a question, and
 * each of those has an owner — `ChatActions`, `RunSession`, `Replier` — with `Transcript`
 * holding what was said, `Busy` holding whether he is working, and
 * `WorkspaceFactsReader` holding what he knows. This file decides which, and wires them
 * together.
 *
 * **It was 1,071 lines and owned all of it.** The split came from a complexity report,
 * but the number was the symptom: routing, modes, runs, history, facts, voice and panel
 * wiring in one class meant every one of those had the same reason to change, and the
 * bugs lived in the seams between them — Stop wired to the wrong signal, a reply that
 * never reached the archive, two owners of "is he busy".
 *
 * **Local answers remain the floor.** A useful share of what you ask a coding assistant
 * is already known — what's failing, what branch, how long that took, have we seen this
 * before — and M3–M5 answer those with no key, no network and no token spend. The model
 * is what phrases them; it is not what knows them.
 */
export class ChatService {
  /** Whether he is doing something, and how to make him stop. */
  private readonly busy: Busy;

  /** Writes the opening and closing lines for a run, when a model is configured. */
  private live:
    | {
        acknowledge(task: string): Promise<string | undefined>;
        afterTask(task: string, summary: string): Promise<string | undefined>;
      }
    | undefined;

  /** Puts a line in character. Every user-facing sentence here goes through it. */
  private voiceOf: Voice | undefined;

  setVoiceWriter(voice: Voice): void {
    this.voiceOf = voice;
  }

  /**
   * Earlier conversations, and clearing this one.
   *
   * Kept on ChatService because the panel and the command palette both call them, and
   * because the empty-archive line is phrased in character — which is a chat concern
   * rather than a storage one.
   */
  async showHistory(): Promise<void> {
    await this.transcript.showHistory(
      await this.phrase('report', 'There are no earlier conversations. This is all there has ever been.')
    );
  }

  async clear(): Promise<void> {
    await this.transcript.clear();
  }

  /** Shorthand: in character where possible, verbatim where not. */
  private async phrase(
    purpose: 'report' | 'warn' | 'ask' | 'aside',
    fallback: string,
    keep?: string[]
  ): Promise<string> {
    return (await this.voiceOf?.say({ purpose, fallback, keep })) ?? fallback;
  }

  /** Supplied by the composition root, so this class stays free of provider details. */
  setLiveLines(live: NonNullable<ChatService['live']>): void {
    this.live = live;
    this.runs.setLiveLines(live);
  }

  /**
   * The last message that was *answered* rather than acted on.
   *
   * Kept so "do it" can mean it. Cleared once used, and never set by an agent run —
   * "do it" after work has already happened would repeat the work.
   */
  private lastAnswered?: string;

  /** Everything he knows about the project, gathered on demand. */
  private readonly workspace: WorkspaceFactsReader;

  /** What was said, where it is kept, and what becomes of it. */
  private readonly transcript: Transcript;

  /** The two paths a question takes once a model is involved. */
  private readonly replier: Replier;

  /** A task, from "on it" to "what would you like done with it". */
  private readonly runs: RunSession;

  /** The things chat can *do*, as opposed to answer. */
  private readonly actions: ChatActions;

  /** Present only while a planning interview is running in the panel. */
  private planningIO?: PlanningChatIO;

  /**
   * True between offering to plan and the user answering.
   *
   * The offer is a question, so the next message is an answer to it — not something
   * to route as a job or a question of its own. Cleared either way, so a "no" (or
   * anything else) never leaves chat quietly intercepting later messages.
   */
  private awaitingPlanAnswer = false;

  /**
   * Runs the whole planning milestone through the chat panel (M9, §4.9).
   *
   * The same flow the command palette drives — only the `PlanningIO` differs, so
   * questions land in the transcript and the next message typed is the answer.
   * Guarded against re-entry: a second interview started mid-interview would have
   * two sets of questions competing for the same replies.
   */
  private async startPlanning(decided?: 'carry-on'): Promise<void> {
    if (this.planningIO) {
      await this.note("We're already in the middle of that one.");
      return;
    }

    const io = new PlanningChatIO(
      (text) => this.remark(text),
      (text) => this.note(text),
      (items) => this.panel.post(items.length ? { type: 'choices', items } : { type: 'choices-clear' }),
      (text) => this.draft.show(text),
      () => this.draft.close(),
      (text) => this.panel.post({ type: 'prefill', text }),
      this.log
    );
    this.planningIO = io;

    // **Plan mode, for the duration.** The interview is the one stretch where a
    // stray "fix the tests" would be actively harmful — a half-finished plan and a
    // half-finished edit, neither signed off — and §0's rule is that nothing but
    // `plan.md` gets written until the plan is approved. Setting the mode makes that
    // visible on the button rather than leaving it as a rule only the code knows.
    const modeBefore = this.actions.mode();
    await this.actions.setMode('plan');

    // **Before the interview, not before the first run.** The offer used to fire only
    // from `RunSession.run()`, which meant a folder with no repository was interviewed,
    // planned and had `plan.md` written into it without git being mentioned once —
    // found live on the second checklist project, where the whole point of the folder
    // was that it had none. Planning is the better moment anyway: it is about to write
    // the first artifact, and the question is whether that artifact will be
    // recoverable. Asked through the chat rather than a modal, because here there is a
    // conversation to put it in and buttons the interview already uses.
    await this.offerGitInChat(io);

    try {
      await runPlanning(
        this.models,
        io,
        {
          acknowledge: (task) => this.live?.acknowledge(task) ?? Promise.resolve(undefined),
          afterTask: (task, summary) => this.live?.afterTask(task, summary) ?? Promise.resolve(undefined),
        },
        this.log,
        // Plan mode hands straight to code mode — the same run path a typed job
        // takes, so nothing about the build is special-cased for having come from
        // planning. Cleared first: the run posts its own questions to chat, and
        // planning must not still be intercepting them.
        async (task, steps) => {
          this.planningIO = undefined;
          // **Agent, not Auto.** Pressing Start Building is an explicit answer to
          // "shall I build this", so the mode that follows should be the explicit
          // one. Auto guesses whether each message is a job or a question, which is
          // a useful default to *choose* and the wrong thing to land in by accident
          // immediately after signing off on a plan.
          await this.actions.setMode('agent');
          this.runs.setStepApproval(true, () => asksFirst(this.actions.mode()));
          // This run has a checklist to tick and has earned the pause afterwards; a
          // one-off "rename this variable" has neither.
          this.runs.setFromPlan(true, steps);
          await this.runs.run(task, 'Plan approved — starting on milestone one.');
        },
        // An interview is two minutes of someone's attention; losing it to a window
        // reload teaches people not to start one.
        workspaceMemory(this.context),
        decided
      );
    } finally {
      this.planningIO = undefined;
      // Restored unless planning already moved on to Agent for the build — putting
      // them back in Plan a second after they approved one would undo the handoff.
      if (this.actions.mode() === 'plan') await this.actions.setMode(modeBefore);
    }
  }

  /**
   * Whether the run in progress consumed this message.
   *
   * Two ways it can, and the order matters. **A run waiting on step approval is not a
   * run to redirect**: "do it" handed to `handleMidRun` would be sent to a model to be
   * judged as possible new scope, while the step sat there waiting for an answer that
   * had already been given. Everything else typed during a run is a correction.
   */
  private async runTook(question: string): Promise<boolean> {
    if (this.runs.awaitingStep) {
      this.runs.answerStep(question);
      return true;
    }

    if (this.runs.isRunning) {
      await this.handleMidRun(question);
      return true;
    }

    return false;
  }

  /**
   * The `git init` offer, asked as a question in the conversation.
   *
   * Declining is remembered the same way the modal's decline is, so the run that
   * follows does not ask a second time — one answer per workspace, whichever surface
   * collected it.
   */
  private async offerGitInChat(io: PlanningChatIO): Promise<void> {
    const offer = await gitOffer(this.context, this.log);
    if (!offer) return;

    const answer = await io.confirm(
      offer.message,
      'Declining is fine — I snapshot files before every run either way, so the work can still be undone.',
      [offer.action, 'Not now']
    );

    if (answer !== offer.action) {
      await declineGitOffer(this.context, offer.problem, this.log);
      return;
    }

    await acceptGitOffer(offer.problem, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, this.log);
    this.log('git offer: accepted during planning');
  }

  /**
   * Something said mid-build: folded in, or kicked back for sign-off.
   *
   * The judgement is a model call, and it fails toward folding in — losing a
   * sign-off costs a decision, stopping a build over a garbled reply costs the run,
   * and the second is the worse trade made every time it fires.
   */
  private async handleMidRun(question: string): Promise<void> {
    const verdict = await judgeScope(this.models, question, this.log);

    if (verdict.kind === 'correction') {
      this.runs.redirect(question);
      this.log('chat: message handed to the run in progress');
      await this.note(await this.phrase('report', "Noted — I'll fold that in.", []));
      return;
    }

    // **The build stops before the gate, not after it.** Leaving it running while
    // the scope is agreed means the code moves on from the plan being amended, and
    // whatever it writes in the meantime nobody approved either.
    this.stop();
    await this.remark(
      await this.phrase(
        'warn',
        `That is new scope, not a correction: ${verdict.summary}. I have stopped, and this needs writing down before I carry on.`,
        []
      )
    );

    this.awaitingScopeAnswer = verdict;
    this.panel.post({ type: 'choices', items: [{ label: 'Add it to the plan' }, { label: 'Forget it' }] });
  }

  /** Set between naming a scope change and the user ruling on it. */
  private awaitingScopeAnswer?: Extract<ScopeVerdict, { kind: 'scope' }>;

  /** Takes the ruling. `true` once it has been dealt with either way. */
  private async answeredScopeOffer(question: string): Promise<boolean> {
    const verdict = this.awaitingScopeAnswer;
    this.awaitingScopeAnswer = undefined;
    this.panel.post({ type: 'choices-clear' });
    if (!verdict) return false;

    if (!/^(add|y|yes|ok|okay|sure|do it)\b/i.test(question.trim())) {
      this.log('chat: scope change declined, plan unchanged');
      await this.note(await this.phrase('report', 'Left out of the plan, then. Say the word when you want it back.', []));
      return true;
    }

    const where = await recordScopeChange(verdict, this.log);
    await this.note(
      where
        ? await this.phrase('report', `${where} Say "carry on" when you want me building again.`, [])
        : await this.phrase(
            'warn',
            'I could not write that into plan.md, so it is agreed and unrecorded — worth adding by hand before it is forgotten.',
            ['plan.md']
          )
    );
    return true;
  }

  /**
   * Offers to pick up a build that was already started here.
   *
   * **Only when work has actually begun.** A freshly approved plan with nothing
   * ticked is not an interrupted build, and offering to continue it every time the
   * window opens would be the nagging §6 exists to prevent. Some progress and
   * something left is the narrow case that means "you were in the middle of this".
   */
  private async offerToResumeBuild(): Promise<boolean> {
    const pending = await interruptedBuild();
    // Already decided by `startupOffer`; re-read here because the offer needs the
    // milestone itself, not just the fact that there is one.
    if (!pending) return false;

    const { number, title, done, total } = pending.milestone;
    this.log(`chat: build in progress — milestone ${number}, ${done}/${total}`);

    // **Two different situations, and one line for both was wrong.** Mid-milestone is
    // "carry on where it stopped"; a milestone finished with the next one untouched is
    // "shall I start the next one" — and reading "milestone 4 is 0 of 2 done" back to
    // someone who just finished milestone 3 describes their progress as nothing.
    const [context, fallback] =
      done > 0
        ? [
            `They were part-way through building "${pending.projectName}": milestone ${number}, ${title}, ${done} of ${total} steps done. You are offering to pick it up where it stopped.`,
            `Milestone ${number} is ${done} of ${total} done. Shall I carry on with it?`,
          ]
        : [
            `They have been building "${pending.projectName}" and the milestone they were on is finished. Milestone ${number} — ${title} — is the next one, ${total} step(s), not started. You are offering to begin it.`,
            `Milestone ${number} is next: ${title}. Shall I start on it?`,
          ];

    await this.remark(await opening(context, fallback));

    this.awaitingBuildAnswer = pending;
    this.panel.post({
      type: 'choices',
      items: [{ label: done > 0 ? 'Carry on' : 'Start it' }, { label: 'Not now' }],
    });
    return true;
  }

  /**
   * Offers to pick up an interview that was interrupted, with its progress named.
   *
   * The three answers are the same three `runPlanning` would have asked, and the
   * choice is passed through so it is not asked twice.
   */
  private async offerToResumeInterview(): Promise<boolean> {
    const snapshot = workspaceMemory(this.context).load();
    if (!snapshot || !worthResuming(snapshot, Date.now())) return false;

    this.log(`chat: unfinished interview here — ${describeProgress(snapshot)}`);
    await this.remark(
      await opening(
        `They closed the window part-way through planning a project and have just come back. ${describeProgress(snapshot)}.`,
        `We were part-way through planning this. ${describeProgress(snapshot)}. Carry on from there?`
      )
    );

    this.awaitingResume = true;
    this.panel.post({
      type: 'choices',
      items: [{ label: 'Carry on' }, { label: 'Start again' }, { label: 'Leave it' }],
    });
    return true;
  }

  /** Set between offering to resume an interview and the user answering. */
  private awaitingResume = false;

  /** Takes the reply to that offer. */
  private async answeredResumeOffer(question: string): Promise<boolean> {
    this.awaitingResume = false;
    this.panel.post({ type: 'choices-clear' });

    const answer = question.trim().toLowerCase();
    if (/^(start again|fresh|start over)/.test(answer)) {
      await workspaceMemory(this.context).clear();
      this.log('planning: unfinished interview thrown away, starting fresh');
      await this.startPlanning();
      return true;
    }

    if (/^(carry on|y|yes|continue|go on|ok|okay|sure)\b/.test(answer)) {
      await this.startPlanning('carry-on');
      return true;
    }

    this.log('planning: unfinished interview left for now');
    return false;
  }

  /** Set between offering to resume a build and the user answering. */
  private awaitingBuildAnswer?: PendingBuild;

  /** Takes the reply to that offer. `true` once the build has been picked up. */
  private async answeredBuildOffer(question: string): Promise<boolean> {
    const pending = this.awaitingBuildAnswer;
    this.awaitingBuildAnswer = undefined;
    this.panel.post({ type: 'choices-clear' });
    if (!pending) return false;

    if (!/^(carry on|start it|y|yes|sure|ok|okay|go on|continue)\b/i.test(question.trim())) {
      this.log('chat: build resume declined');
      return false;
    }

    await this.startNextMilestone(
      nextMilestoneTask(pending.milestone, pending.projectName, pending.milestones),
      pending.steps
    );
    return true;
  }

  /**
   * Says a project is finished, in the conversation, with what it consists of.
   *
   * **Spoken as well as written**, and one of the few things that earns it: the end of
   * a project is the single most useful thing he will say all week, and §4.4's ration
   * exists to protect moments like this rather than to rule them out.
   *
   * The aside afterwards is separate and written by the model, the same split every
   * other report uses — the facts stay a report, and the remark stays a remark.
   */
  async announceProjectFinished(lines: string[]): Promise<void> {
    const [headline, ...rest] = lines;
    this.log(`planning: project finished — ${headline}`);

    await this.remark(headline);
    if (rest.length) await this.note(rest.join('\n'));

    const aside = await this.phrase(
      'aside',
      'I would say it was a pleasure, but you were here for most of it.',
      []
    );
    if (aside) await this.note(aside);
  }

  /**
   * What to do about what the read-back found.
   *
   * Three answers, and the middle one is the reason this is worth building: findings
   * written into the plan become a milestone with steps and checks, which is a thing
   * that gets built. Findings in a transcript are a thing that scrolls away.
   */
  private async answeredReviewOffer(question: string): Promise<boolean> {
    const findings = this.runs.takeReviewFindings();
    this.panel.post({ type: 'choices-clear' });
    if (!findings) return false;

    const answer = question.trim().toLowerCase();

    if (/^(fix|fix them|fix them now|yes|do it)\b/.test(answer)) {
      this.log(`review: fixing ${findings.length} finding(s) now`);
      await this.runs.run(fixFindingsTask(findings), 'Right — before anything else, then.');
      return true;
    }

    if (/^(add|add to the plan|plan|write)\b/.test(answer)) {
      const added = await addFindingsToPlan(findings, this.log);
      await this.note(
        added
          ? `Written into plan.md as milestone ${added}. It gets built when you say so, like any other.`
          : "I couldn't write those into the plan — they are in the log."
      );
      return true;
    }

    this.log(`review: ${findings.length} finding(s) left alone`);
    return true;
  }

  /**
   * The action a matcher missed but a model recognised.
   *
   * Only ever a suggestion, and a declined one falls through to a normal answer (M8f2).
   * Planning is the exception it has to handle itself: it owns the conversation for the
   * next several minutes, which is ChatService's to hand over rather than an action's
   * to start.
   */
  private async inferredActionTook(question: string): Promise<boolean> {
    const inferred = await this.actions.offerInferred(question);

    if (inferred === 'planProject') {
      await this.startPlanning();
      return true;
    }

    return Boolean(inferred);
  }
  /**
   * The two things that must happen before a message is routed at all.
   *
   * Stop first, always: "stop" means stop even when something is waiting on an answer,
   * and an offer that swallowed it would make the one word that must always work the
   * one word that did not. Then a pending offer, because a reply to a question just
   * asked is an answer to it rather than a new request.
   */
  private async stoppedOrAnswered(question: string): Promise<boolean> {
    if (isStopRequest(question)) {
      await this.stopFromChat();
      return true;
    }

    if (this.offers.isWaiting) {
      this.offers.supply(question);
      return true;
    }

    return false;
  }
  /**
   * Offers to step into Agent for one job, then step back.
   *
   * **The old answer was homework.** "That's a job, and Chat only won't let me change
   * files. Switch to Agent or Auto and ask again" — correct, and it made the user do
   * the mode change *and* retype the request, to reach a thing Clarvis could plainly
   * see they wanted. The restriction is worth keeping; making them re-ask for it is not.
   *
   * **Borrowed, not moved.** The mode goes back afterwards, because someone in Chat
   * only chose that on purpose and one fix is not a decision to leave the safety catch
   * off. Unless they changed it themselves during the run, in which case the newer
   * choice is theirs and stands — the same rule planning already follows on handoff.
   */
  private async offerToBorrowAgent(question: string, mode: ChatMode): Promise<boolean> {
    this.log(`chat: job blocked by ${mode} mode, offering to borrow Agent`);

    await this.note(
      await this.phrase(
        'ask',
        `That's a job, and ${modeSpec(mode).label} won't let me change files. I can borrow Agent for this one and hand it straight back.`,
        [modeSpec(mode).label]
      )
    );

    const answer = await this.offers.ask([
      { label: 'Do it in Agent mode', detail: `One job, then back to ${modeSpec(mode).label}` },
      { label: 'Tell me what you would change', detail: 'No edits — just the answer' },
      { label: 'Leave it', detail: 'Nothing happens' },
    ]);

    if (answer === 'Leave it') {
      this.log('chat: job declined, mode unchanged');
      return true;
    }

    // Anything that is not a yes falls through to the ordinary answer, which is what
    // the second button asks for and what an unrelated reply deserves anyway.
    if (answer !== 'Do it in Agent mode') return false;

    await this.actions.setMode('agent');
    this.runs.setStepApproval(true, () => asksFirst(this.actions.mode()));
    this.runs.setFromPlan(false);

    try {
      await this.runs.run(question, 'Borrowing Agent for this one.');
    } finally {
      // Only if they have not moved it themselves in the meantime: switching to
      // Unattended mid-run is a decision, and undoing it here would be this method
      // overruling the user about their own editor.
      if (this.actions.mode() === 'agent') {
        await this.actions.setMode(mode);
        this.log(`chat: handed Agent back, returned to ${mode}`);
      }
    }

    return true;
  }

  /**
   * One-shot offers made from `ask` itself, as opposed to the ones a run makes.
   *
   * The same mechanism the interview uses: a promise resolved by the next message,
   * with buttons alongside. Checked before routing, since a reply to a question is not
   * a new request.
   */
  private readonly offers = new PendingChoice((items: { label: string; detail?: string }[]) =>
    this.panel.post(items.length ? { type: 'choices', items } : { type: 'choices-clear' })
  );
  /**
   * Starts the next milestone from an approved plan.
   *
   * Same run path as the first one — step approval on, progress showing, the pause
   * afterwards — because nothing about the second milestone is special except which
   * part of the plan it is building.
   */
  async startNextMilestone(task: string, steps: string[]): Promise<void> {
    await this.actions.setMode('agent');
    this.runs.setStepApproval(true, () => asksFirst(this.actions.mode()));
    this.runs.setFromPlan(true, steps);
    await this.runs.run(task, 'Right — on to the next one.');
  }

  /**
   * Whether planning consumed this message — either as an answer to a question it
   * asked, or as the reply to the offer to start.
   */
  private async planningTook(question: string): Promise<boolean> {
    if (this.runs.hasReviewFindings) return this.answeredReviewOffer(question);
    if (this.awaitingResume) return this.answeredResumeOffer(question);
    if (this.awaitingScopeAnswer) return this.answeredScopeOffer(question);
    if (this.awaitingBuildAnswer) return this.answeredBuildOffer(question);
    if (this.awaitingPlanAnswer) return this.answeredPlanOffer(question);
    if (!this.planningIO?.isWaiting) return false;

    if (isStopRequest(question)) {
      this.log('chat: planning cancelled from chat');
      this.planningIO.cancel();
      return true;
    }
    this.planningIO.supply(question);
    return true;
  }

  /** Takes the reply to the planning offer. `true` once planning has started. */
  private async answeredPlanOffer(question: string): Promise<boolean> {
    this.awaitingPlanAnswer = false;
    this.panel.post({ type: 'choices-clear' });

    const answer = offerAnswer(question);

    // **Changing the subject is not declining.** Found live seconds after the previous
    // fix shipped: "anything wrong in here?" arrived while the offer was up, was filed
    // as a decline, and was answered with "Noted. I will not bring it up again here."
    // The offer goes away — they have plainly moved on — but the message is theirs and
    // routes normally, and nothing is remembered about a refusal that never happened.
    if (answer === 'unrelated') {
      this.log('chat: planning offer dropped, that message was about something else');
      return false;
    }

    if (answer === 'yes') {
      await this.startPlanning();
      return true;
    }

    // **"No" is an answer, and it used to fall through to a fresh reply.** Found live:
    // three windows in a row where declining produced "That is not a question. I remain
    // here, unimpressed but ready" — him being baffled by the answer to his own
    // question. Returning true consumes the message; the offer was the question.
    this.log('chat: planning offer declined, remembered for this workspace');
    await this.context.workspaceState.update(PLAN_OFFER_DECLINED, true);
    await this.note(await this.phrase('report', 'Noted. I will not bring it up again here.', []));
    return true;
  }

  /**
   * Shows a plan draft in the editor, rendered rather than as raw markdown.
   *
   * Markdown's preview is the whole point here — the draft is being *read*, by
   * someone deciding whether to approve it, and asking them to parse hashes and
   * asterisks while they do that is the opposite of help. Beside the editor rather
   * than over it, so the chat panel and its question stay visible.
   */
  /**
   * The single editor tab the interview draws in.
   *
   * Held here rather than made per interview so a second `/plan` in the same window
   * reuses it too.
   */
  private readonly draft = new DraftDocument();

  /**
   * Offers to plan, once, when a project has no `plan.md` of its own.
   *
   * **An offer, not an ambush.** §4.9 wants planning to be the front door, and a
   * project with no plan is exactly who it is for — but launching a ten-minute
   * interview because someone opened a folder would be the nagging this product is
   * written against (§6). So: a single line in the transcript, and nothing happens
   * unless they answer it.
   */
  async offerPlanningIfUnplanned(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    const planExists = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'plan.md')).then(
      () => true,
      () => false
    );

    // **The order lives in one pure function, because it has been wrong twice.** The
    // resume-build offer was written to fire "before anything else" and sat *after* a
    // guard returning when `plan.md` exists — and a build in progress always has one,
    // so it never ran. Found live: milestones 1 to 3 finished, window reopened, nothing
    // offered, build restarted by hand.
    // **Asked once per workspace, not once per window.** Declining is a decision about
    // this project, and re-asking every time the window opens is the nagging §6 exists
    // to prevent — observed three times in one afternoon, with the same answer each time.
    if (this.context.workspaceState.get<boolean>(PLAN_OFFER_DECLINED)) {
      this.log('chat: planning already declined here, not offering again');
      return;
    }

    const snapshot = workspaceMemory(this.context).load();
    const offer = startupOffer({
      planExists,
      buildInProgress: Boolean(await interruptedBuild()),
      interviewInProgress: Boolean(snapshot && worthResuming(snapshot, Date.now())),
    });

    if (offer === 'nothing') return;
    if (offer === 'resume-build') {
      await this.offerToResumeBuild();
      return;
    }
    if (offer === 'resume-interview') {
      await this.offerToResumeInterview();
      return;
    }

    // What is actually here, so the line can react to *this* folder rather than to
    // the abstract fact of a missing file. An empty one deserves "oh, a new project?";
    // one with a year of code in it and no plan does not.
    const signals = await researchWorkspace();
    const looksNew = signals ? !signals.hasGit && signals.topLevelEntries.length <= 2 : false;
    this.log(`chat: no plan.md here, offered to plan${looksNew ? ' (looks like a new project)' : ''}`);

    // **A question with buttons, not an instruction to remember a command.** Spoken
    // as well as written: it is the one line that tells someone this feature exists,
    // and a notice nobody hears is a feature nobody finds.
    await this.remark(
      await opening(
        [
          looksNew
            ? 'They have just opened what looks like a brand new project: an empty folder, nothing built yet, and no plan.md.'
            : 'They have opened a project that already has files in it — someone has been working here — but there is no plan.md, so none of it was ever written down.',
          signals ? `What is actually in the folder: ${describeWorkspaceSignals(signals)}` : '',
          '',
          'Two beats, in this order. First: notice what you have walked into and have a',
          'view about it — a new project deserves a different remark from one already',
          'full of code nobody planned, and a line that merely restates "there is no',
          'plan.md" is a failed line.',
          'Then: offer to plan it with them — an interview, then a written plan they',
          'sign off on.',
        ]
          .filter(Boolean)
          .join(' '),
        looksNew
          ? 'Oh, a new project? We could sketch out what this is meant to do before the next person asks — or would you rather keep discovering it as we go?'
          : 'No plan.md, and a folder full of files that presumably mean something to someone. Would you like help working out what this is?'
      )
    );
    this.awaitingPlanAnswer = true;
    this.panel.post({ type: 'choices', items: [{ label: 'Yes' }, { label: 'No' }] });
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: ButlerViewProvider,
    private readonly avatar: AvatarController,
    private readonly tracker: BusyTracker,
    // Suppliers rather than the owning services: chat reads two facts, and taking
    // BriefingService and PatternMemory wholesale would couple it to everything
    // else those two happen to do.
    private readonly recentFiles: () => string[],
    private readonly patterns: () => Pattern[],
    /** Drops what M5 remembers about a job, for when the user asks him to let it go. */
    private readonly forgetPattern: (needle: string) => Promise<number>,
    private readonly voice: VoiceService,
    private readonly models: ModelService,
    private readonly terminal: AgentTerminal,
    /**
     * Shared run state: whether a run is happening, and what it committed. Quips keep
     * out of the way during one, and never celebrate its commits afterwards.
     */
    private readonly agentBusy: { running: boolean; noteCommit?: (hash: string) => void },
    private readonly log: (message: string) => void
  ) {
    this.workspace = new WorkspaceFactsReader(context, tracker, recentFiles, patterns);
    this.transcript = new Transcript(context, panel, log);
    this.busy = new Busy(panel, agentBusy);
    this.runs = new RunSession(
      context,
      avatar,
      models,
      terminal,
      this.busy,
      (text) => this.note(text),
      (text) => this.remark(text),
      (purpose, fallback, keep) => this.phrase(purpose, fallback, keep),
      (frame) => panel.post({ type: 'progress', ...frame }),
      (items) => panel.post(items.length ? { type: 'choices', items } : { type: 'choices-clear' }),
      log
    );
    this.replier = new Replier(
      panel,
      avatar,
      voice,
      models,
      terminal,
      this.transcript,
      this.busy,
      context,
      (text, state) => this.say(text, state),
      log
    );
    this.actions = new ChatActions(
      panel,
      voice,
      models,
      (text, state) => this.say(text, state),
      (text) => this.note(text),
      log,
      context,
      (needle) => this.forgetPattern(needle),
      patterns
    );

    this.panel.onDidAsk((question) => void this.ask(question));
    this.panel.onDidToggleMute(() => this.voice.setMuted(!this.voice.isMuted));
    this.panel.onDidRequestClear(() => void this.confirmAndClear());
    this.panel.onDidRequestHistory(() => void this.showHistory());
    // **Reveal, not a new view.** Every command and tool call already goes to the
    // Clarvis terminal — a run's actual output has been one click away the whole
    // time, with nothing in the panel saying so. `show(true)` keeps focus where it
    // is: the point is seeing what is happening, not being dragged to it.
    this.panel.onDidRequestOutput(() => this.terminal.reveal());
    // The same path a typed "stop" takes, so clicking it while nothing is running says
    // so rather than silently doing nothing — which, on an always-visible button, would
    // read as the button being broken.
    this.panel.onDidRequestStop(() => void this.stopFromChat());
    this.panel.onDidRequestModels(() => void vscode.commands.executeCommand('clarvis.configureModels'));
    this.panel.onDidRequestMode(() => void this.actions.chooseMode());

    // Keep the bowtie's tooltip honest when the settings change underneath it —
    // including from the picker it opens, so it never describes the previous choice.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('clarvis.chat') || event.affectsConfiguration('clarvis.agent')) {
          this.actions.postModelInfo();
          this.actions.postMode();
          // **A switch to Unattended answers the question already on the table.**
          // Found live: someone switched mid-run with a step waiting, and still had
          // to press the button — the mode took effect from the *next* step, which
          // is not what "stop asking me" means when a question is sitting there. A
          // config listener rather than a hook on the picker, so it fires however the
          // mode was changed.
          this.runs.modeStoppedAsking();
        }
      })
    );

    // Roll the previous session into the archive before anything is written to it.
    // Done at *startup* rather than shutdown, because shutdown is not guaranteed to
    // happen — this way a crashed window's conversation is filed on next launch.
    void this.transcript.rollOver();

    // A newly resolved webview knows nothing. Replaying keeps a panel move or a
    // reload from looking like the conversation was thrown away.
    this.panel.onDidBecomeReady(() => {
      this.transcript.replay();
      // A panel moved mid-run comes back blank, and a run with no Stop button is a run
      // you cannot call off.
      this.busy.show(this.busy.isBusy);
      this.panel.post({ type: 'mute', muted: this.voice.isMuted });
      this.actions.postModelInfo();
      this.actions.postMode();
    });

    this.voice.onMuteChange((muted) => this.panel.post({ type: 'mute', muted }));
  }

  /** Answers a question, records both halves of the exchange, and shows the reply. */
  /**
   * Whether this message is work, and what to call it if so.
   *
   * Three ways in, in the order they can be trusted. "Do it" refers to the thing just
   * described, and is the four-character recovery for a verb list that will always be
   * missing the word someone used. The keyword router decides when it can. The model is
   * asked only when the router fell through — a question with a question mark needs no
   * second opinion, and paying for one on every message would be absurd.
   *
   * **Routing comes before the local answer**, which it did not always: the local
   * matcher swallowed jobs, because "make a new branch called testing3" contains the
   * word "branch" and was answered with the current branch name. A keyword match for a
   * question is not evidence that a request is one.
   */
  /**
   * Treats a reply as the answer to a question a run stopped on.
   *
   * **Whatever it looks like.** Replies to a stopped run are "retry", "continue", "the
   * second one" — none of which route as a job, so this check used to sit inside the
   * job branch and never fired. Found live: a run stopped for a missing Go toolchain,
   * and both "retry" and "continue" reached a model with no idea what was being
   * retried, which asked the user what they meant. Twice.
   *
   * The pending question is consumed by reading, so exactly one message is treated
   * this way — changing the subject after a question costs nothing but the answer.
   */
  private async continuedTheRun(question: string, mode: ChatMode): Promise<boolean> {
    const pending = canEdit(mode) ? this.runs.takeUnanswered() : undefined;
    if (!pending) return false;

    this.log('chat: treating that as an answer to the run that just asked');
    this.runs.setStepApproval(asksFirst(mode), () => asksFirst(this.actions.mode()));
    this.runs.setFromPlan(false);
    await this.runs.run(
      [
        `Continue this task: ${pending.task}`,
        '',
        `You stopped and asked:\n${pending.question}`,
        '',
        `They answered:\n${question}`,
        '',
        'Update plan.md with what they have just settled, then carry on building.',
      ].join('\n'),
      'Right — that settles it.'
    );
    return true;
  }

  private async jobIn(
    question: string,
    mode: ChatMode,
    decision: ReturnType<typeof routeFor>
  ): Promise<{ task: string; because: string } | undefined> {
    if (!canEdit(mode)) return undefined;

    if (this.lastAnswered && isDoItNow(question)) {
      const task = this.lastAnswered;
      this.lastAnswered = undefined;
      this.log(`chat: escalating the previous message to the agent — "${task.slice(0, 60)}"`);
      return { task, because: 'Right — doing it properly this time.' };
    }

    if (decision.route === 'agent') {
      this.log(`chat: routed to agent — ${decision.because}`);
      return {
        task: question,
        because: mode === 'agent' ? 'Agent mode — treating that as a job.' : decision.because,
      };
    }

    if (mode !== 'plan' && needsClassification(question)) {
      const classified = await classifyIntent(this.models, question, this.log);

      if (classified === 'agent') {
        this.log('chat: routed to agent by the model, after the verb list missed it');
        return { task: question, because: 'That reads as a job, so I picked up the tools.' };
      }
    }

    return undefined;
  }

  async ask(question: string): Promise<void> {
    await this.transcript.add({ speaker: 'user', text: question, at: Date.now() });

    // **While planning runs, every message is an answer to the question just asked.**
    // Routing it — stop, action, job, question — would be four chances to misread
    // "yes" or "3" as something else entirely, so `ask()` gets out of the way.
    // Planning owns the message when it is mid-question, or when the offer to plan
    // is still hanging. Both are questions Clarvis just asked, and routing an answer
    // to them as a job or a query would be several chances to misread "yes".
    if (await this.planningTook(question)) return;

    // Before anything that costs a request: someone typing "stop" wants the thing to
    // stop, and asking a model about it first is both slow and beside the point.
    if (await this.stoppedOrAnswered(question)) return;

    // **Typing during a run redirects it.** Anything else is worse: answering it
    // separately leaves the user watching the agent carry on doing the thing they
    // just asked it not to, and stopping to restart throws away everything read so
    // far — so "no, use the other library" would cost a whole run.
    //
    // Unless it is not a correction at all. §0: scope discovered mid-build kicks
    // back to Plan Mode rather than growing silently inside Code Mode.
    if (await this.runTook(question)) return;

    // Requests to *open* something are handled before answering: "change the voice"
    // wants the picker, not a paragraph about where the setting lives.
    const action = chatAction(question);
    if (action === 'planProject') {
      await this.startPlanning();
      return;
    }
    if (action) {
      await this.actions.run(action, question);
      return;
    }

    // The matcher missed. A model may recognise it anyway — but only as a suggestion,
    // and a declined suggestion falls through to a normal answer (M8f2). Planning is
    // the one action ChatActions cannot run itself: it owns the whole conversation
    // for the next several minutes, which is ChatService's to hand over, not its.
    if (await this.inferredActionTook(question)) return;

    const mode = this.actions.mode();

    if (await this.continuedTheRun(question, mode)) return;

    const decision = routeFor(question);

    const job = await this.jobIn(question, mode, decision);
    if (job) {
      // **The mode says whether to ask, not which mode it is.** This used to read
      // `mode === 'agent'`, which meant Auto — the default — ran destructive commands
      // with no prompt. Routing and approval are separate questions and are asked
      // separately now.
      this.runs.setStepApproval(asksFirst(mode), () => asksFirst(this.actions.mode()));
      this.runs.setFromPlan(false);
      await this.runs.run(job.task, job.because);
      return;
    }

    // **A job the mode will not let him do is worth saying so.** Without this the log
    // read "routed to answer — that reads as a job", the reply explained that it could
    // not edit anything, and the user was left to work out for themselves that a mode
    // was the reason. Said before the answer rather than instead of it: the answer is
    // still useful, and the note is what makes the refusal make sense.
    if (decision.route === 'agent' && !canEdit(mode)) {
      if (await this.offerToBorrowAgent(question, mode)) return;
    }

    // **The model phrases it; local state supplies the facts.** Canned answers are
    // instant and free, and they always sound canned — five fixed shapes, however the
    // question was asked. Handing the same facts to the model costs one cheap request
    // and gets an answer in Clarvis's voice that can also reason about them.
    this.log(`chat: routed to answer — ${decision.because}`);
    this.lastAnswered = question;
    const facts = await this.workspace.read();

    if (await this.models.isReady('chat')) {
      // Capabilities before facts: what he is, then what he has seen. Without the
      // first he answered questions about himself as a read-only tool that "reads and
      // remarks" — a description of the mode, delivered as a description of the self.
      const addendum = `${mode === 'plan' ? PLAN_ADDENDUM : ''}${capabilities(mode)}${factsBlock(facts)}`;
      await this.replier.withModel(question, addendum);
      return;
    }

    // No model configured, or unreachable. The canned answers are the fallback rather
    // than the default: worse prose, but they need no key and no network, which is
    // exactly the situation they are for.
    const reply = localAnswer(question, facts);
    if (reply) {
      this.log('chat: answered from local state (no model available)');
      await this.say(reply.text, reply.state);
      return;
    }

    await this.say(
      "That's beyond what I've watched happen here, and there's no model wired up to think about it. The bowtie by the prompt sorts that out.",
      'neutral'
    );
  }

  /** The read-only tool loop, for questions that need to see the code. */
  /** Cancels the answer in flight, if there is one. */
  stop(): void {
    this.busy.stop();
  }

  /**
   * Tells the panel whether there is something to stop.
   *
   * **Not inferred from the text stream, which is how it broke.** Stop was shown on
   * `chat-stream-start` and hidden on `chat-stream-end` — frames only the two *answer*
   * paths post. An agent run posts neither, so the button was hidden for the whole of a
   * run: invisible in the one situation it exists for, and visible only while a reply
   * was already finishing.
   */

  /**
   * "Stop", typed rather than clicked.
   *
   * Answered locally either way. When there is something to stop it is stopped and said
   * briefly; when there is not, saying so costs nothing and is more useful than a model
   * being asked what "stop" means.
   */
  private async stopFromChat(): Promise<void> {
    const busy = this.busy.isBusy;

    // **Once per thing stopped.** Four clicks during one run produced four separate
    // replies — and because each was a rewrite of the word "Stopped." with no facts
    // attached, the model filled the space with invented history: a test suite failing
    // on a branch that does not exist, for a number of days nothing measures.
    if (busy && !this.busy.claimAnnouncement()) {
      this.stop();
      return;
    }

    if (!busy) {
      this.log('chat: asked to stop, nothing running');
      await this.say(await this.phrase('report', 'Nothing to stop. I was already idle.'), 'neutral');
      return;
    }

    this.log('chat: stopped by typed request');
    const runWillSayIt = this.busy.isRunning;
    this.stop();

    // **One "Stopped." per stop.** A run reports its own ending, so saying it here too
    // produced two lines — and because each was independently rewritten, they did not
    // even agree with each other.
    if (runWillSayIt) return;

    // Verbatim, not phrased. It is two words of status at a moment the user is anxious,
    // there is nothing in it to be funny about, and every rewrite of it so far has
    // either invented a project or complained about not having been given one.
    await this.say('Stopped.', 'neutral');
  }

  /**
   * Records something Clarvis said on his own initiative — a briefing, a completion
   * notice, a pattern hit, a quip.
   *
   * Notifications vanish after a few seconds and are gone for good; anything worth
   * saying is worth being able to scroll back to. This is a *copy*, not a
   * replacement: the toast still fires, and the budget that governs whether it
   * fires at all is unchanged (§6).
   */
  async note(text: string): Promise<void> {
    // No setState here on purpose: the caller already chose a face and owns the hold
    // timer that returns it to rest. Setting it again from here would fight them.
    await this.transcript.add({ speaker: 'clarvis', text, at: Date.now() });
  }

  /**
   * Asks first, then clears.
   *
   * The button sits next to Mute, which gets clicked constantly, and there is no undo
   * — so a misclick would silently destroy the history. Skipped entirely when the
   * thread is already empty, since confirming a no-op is just noise.
   */
  async confirmAndClear(): Promise<void> {
    if (this.transcript.isEmpty) return;

    const confirmed = await vscode.window.showWarningMessage(
      'Clear the conversation? This cannot be undone.',
      { modal: true },
      'Clear'
    );
    if (confirmed !== 'Clear') return;

    await this.clear();
  }

  /** Opens the manual, for the command-palette route as well as `/help`. */
  async openHelp(): Promise<void> {
    await this.actions.openManual();
  }

  /**
   * Says something out loud *and* writes it down.
   *
   * Distinct from `note()`, which only records. The difference is who already spoke:
   * briefings, quips and completion notices are voiced by whatever raised them, so
   * making `note()` speak would say all of them twice. The wizard has no voice of its
   * own, and its lines are the direct result of a button the user just pressed —
   * solicited, per §4.4, and therefore never a surprise.
   */
  async remark(text: string): Promise<void> {
    await this.note(text);
    this.voice.say(text, 'chatReply');
  }

  /** Posts a reply, sets the face to match it, and returns the face to rest after. */
  private async say(text: string, state: Parameters<AvatarController['setState']>[0]): Promise<void> {
    await this.transcript.add({ speaker: 'clarvis', text, at: Date.now() });
    this.avatar.setState(state, 'chat');

    // Spoken as well as written. The reply is on screen either way — voice is never
    // the only copy, so muting or a broken key costs delivery, never the answer.
    // VoiceService owns talking/neutral from actual playback, which is why the state
    // above is set first and not fought over here.
    this.voice.say(text, 'chatReply');
  }

}
