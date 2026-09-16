import * as vscode from 'vscode';
import { ModelService } from '../model/ModelService';
import { ModelMessage, ToolCall, ToolResult } from '../model/ModelProvider';
import { isToolName, mutates, validateArgs, readOnlyTools, runTools, ToolName, type ToolSchema } from './toolRegistry';
import { explainStep, StepExplanation } from './stepExplanation';
import { agentSystemPrompt } from './agentPrompt';
import { changesAFile, isLookingAround, narrateTool } from './toolNarration';
import { interjectionMessage } from './interjections';
import { commitSubject } from './commitSubject';
import { toolCallsInText } from './textToolCalls';
import { phrase } from '../personality/Voice';
import {
  allowsNetwork,
  approveLabel,
  classifyCommand,
  ESCAPE_LABEL,
  explainGate,
  GateVerdict,
  mayEscapeConfinement,
} from './Gate';
import { classifyPath } from './sensitivePath';
import { gateOutcome } from './gateDecision';
import { whileAwaiting, type Activity } from '../bridge/activity';
import { Checkpoint } from './Checkpoint';
import { AgentBranch } from './AgentBranch';
import { readFile, listFiles, search } from './tools/fileTools';
import { applyEdit, writeFile } from './tools/editTools';
import { AgentTerminal, CommandResult, gitDiff, gitStatus, readDiagnostics, runCommand } from './tools/commandTools';
import { mayRunUnconfined, spawnFor } from './tools/sandbox';
import { confinementNote } from './tools/confinement';
import {
  invokedSkillLog,
  invokedSkillSection,
  NO_SKILLS,
  readSkillFor,
  skillCallDetail,
  spendsAStep,
  startRunSkills,
  type InvokedSkill,
  type RunSkills,
  type SkillsLookup,
} from './tools/skillTools';
import {
  activeBlocker,
  BLOCKER_KEY,
  blockerRecord,
  clearsBlocker,
  explainMissing,
  missingDependency,
  MissingDependency,
  missingOptions,
  missingOutcome,
  MissingOutcome,
} from './missingDependency';
import { announcesStep } from './stepProgress';
import * as path from 'path';
import { canonicalRelative, resolveInWorkspace } from './tools/workspacePaths';
import { explainHeldBack } from './dirtyAtStart';
import { ANSWER_SHAPE } from '../personality/character';
import { ReplyStateReader, STATE_TAG_INSTRUCTION, stripTags } from '../chat/replyState';
import { stepAfterAsking } from '../chat/stopDecision';
import { absorbStreamEvent } from './streamNarration';
import { newTraceId } from '../model/lineage';
import type { CodingRun, RunFence } from '../engine/CodingRun';
import type { CheckRecord, UncertainOperation } from '../engine/checkpoint/taskCheckpoint';
import type { BranchContinuation } from './branchNames';

/** How a run of Clarvis's own engine starts when it carries a task on from another engine (M15 C3). */
export interface AgentEngineOptions {
  /** Continue the task on its branch at the saved commit (review B2), instead of starting a new branch. */
  continueOn?: BranchContinuation;
  /** Told once the branch is in place, right before the first model call: a switch counts the run started then. */
  onStarted?: () => void;
  /**
   * **Build on** Clarvis's own earlier run (plan.md M15): what that run was asked and said, and the commits on its branch
   * (`leftRuns.earlierWorkBrief`), told to the model after its instructions. Never part of the task, so the commit's
   * `Task:` line stays the owner's request.
   */
  earlierWork?: string;
  /** The owner chose **Start fresh**: never stacked on the `clarvis/*` branch the window is on (`freshStartRefusal`). */
  startFresh?: boolean;
}
import { describeProcess } from '../engine/lock/processProbe';
import { mayCommitNow, mayWriteNow, TAKEN_OVER_LINE, TAKEN_OVER_TOOL_RESULT } from './lockFence';

/**
 * The loop: ask the model, run what it asks for, hand back the results, repeat.
 *
 * Every safety property lives *below* this class — the workspace boundary in
 * `resolveInWorkspace`, the deny-list in `Gate`, undo in `Checkpoint`, isolation in
 * `AgentBranch`. This file coordinates them and is deliberately not where any of them
 * are decided, so no amount of clever prompting can reach a decision point that only
 * exists here.
 */

/** Reported as the run goes, so the panel can show work rather than a spinner. */
export interface AgentEvent {
  /**
   * `status` is a passing state of a run, shown under the chat until the next one replaces it (empty text clears it)
   * and never written to the transcript or kept: "Reconnecting Codex…" while RAVIS reopens a Codex task (M15 C2b+).
   */
  kind: 'text' | 'tool' | 'gate' | 'done' | 'error' | 'status';
  /**
   * True when this step is Clarvis reading rather than changing something.
   *
   * The transcript collapses a run of these into one line; the log keeps every one.
   */
  quiet?: boolean;
  /**
   * True for a `text` event that belongs in the chat, not only the terminal.
   *
   * Most `text` events are the model narrating its own steps mid-loop — deliberately
   * unlogged and terminal-only, per §the "no machine talk" rule. The isolation advice
   * from `protect()` is the opposite: it is the one thing standing between the user and
   * a `git init` offer that never appeared, because the chat path forwarded nothing but
   * `done` events and everything else silently went to the terminal alone. Observed
   * live — a non-repo folder produced no offer, no message, nothing.
   */
  toChat?: boolean;
  /** For the transcript: what a person would say. */
  text: string;
  /**
   * For the log: the tool name and its arguments.
   *
   * Two forms rather than one, because they have different readers. "Editing app.js"
   * is what someone watching wants; `applyEdit: app.js` is what someone debugging
   * wants, and neither is much use to the other.
   */
  detail?: string;
  /** Files touched so far, for the commit and the summary. */
  /**
   * Where the run left them — branch, and what happened to it.
   *
   * Separate from `text` rather than appended to it: joined, an empty narration looked
   * like a summary, and the honest "I stopped without changing anything" line never
   * fired.
   */
  closing?: string;

  files?: string[];
  step?: number;
}

export class AgentRunner implements CodingRun {
  /** Which engine this is, for the chat's run (M15 C2a: the other one is Codex, through RAVIS). */
  readonly engine = 'clarvis' as const;
  private readonly touched = new Set<string>();
  /** Commits this run made, so a review can tell them from anyone else's. */
  private readonly ownCommits: string[] = [];

  /** Whether the run's own branch was removed for holding nothing. */
  private tidied = false;

  /**
   * The isolation announcement, waiting for a reason to exist.
   *
   * Undefined once said — or never said at all, for a run that changed nothing.
   */
  private pendingIsolation: string | undefined;
  /** Calls that spent a step, against the cap. A run's first skill reads spend none (`spendsAStep`). */
  private steps = 0;
  /** Every tool call so far: the step numbers the transcript and the ledger show. */
  private calls = 0;
  /** `readSkill` calls so far, free or not. */
  private skillReads = 0;
  /** The owner's skills for this run, read at its start. None for an answer (plan.md §4.6, "Skills"). */
  private runSkills: RunSkills = NO_SKILLS;
  /** The skill the owner invoked with a slash command, its SKILL.md already read (15 Sep 2026). Set by `invokeSkill`. */
  private invoked: InvokedSkill | undefined;
  /** The invoked skill's section of the instructions, built once as the run or answer begins. */
  private invokedText = '';
  /** Whether the run ended because it used every step it was allowed. See `endedAtStepCap`. */
  private stepCapped = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly root: string | undefined,
    private readonly models: ModelService,
    private readonly terminal: AgentTerminal,
    private readonly log: (message: string) => void,
    /**
     * Asked before every step that acts, when the caller wants it (Agent mode).
     *
     * Absent in Auto, which is the mode whose whole proposition is deciding for
     * itself — a mode that asked before each step would be Agent with extra words.
     * Absent for read-only calls in every mode: approving a file *read* six times
     * teaches people to click yes without reading, which is worse than not asking.
     */
    private readonly approveStep?: (step: StepExplanation) => Promise<boolean>,
    /**
     * Where a pending gate is recorded, when the caller has somewhere to record it
     * (M14).
     *
     * **Only the fact, never the question.** `CLARVIS.md` §6.7 lets NERVIS show
     * *that* an approval is outstanding and forbids it resolving one; §6.4 keeps
     * the command, the path and the prompt text on this machine. So what goes in
     * is a category, and there is nowhere here to put anything else.
     *
     * Optional because a runner that answers to nobody is a real case — the
     * palette route had no shared state at all until this milestone.
     */
    private readonly activity?: Activity,
    /**
     * The project lock this run holds, when it holds one (M15 C2a; design §6.3, the fence).
     *
     * Checked before every tool call that writes and before the commit: a run another window took
     * over stops at once and writes nothing more — no edit, no command, no commit, no tidying. Absent
     * for a read-only answer, which takes no lock.
     */
    private readonly fence?: RunFence,
    /** How this run starts when it carries a task on from another engine (M15 C3). */
    private readonly engineOptions: AgentEngineOptions = {},
    /**
     * Where a run reads the owner's skills (plan.md §4.6, "Skills"), asked at the run's start. Absent means none: the
     * answer path, and every other runner built without it, gets no skills.
     */
    private readonly skills?: () => SkillsLookup
  ) {}

  /** The tool call a stop cut off, if one was (M15 C3). */
  private cutOff?: UncertainOperation;

  /** Every command this run ran, and how it ended, for the checkpoint (M15 C3). */
  private readonly commandsRun: CheckRecord[] = [];

  /**
   * The tool call that was changing something when the run stopped, if any: a switch lists it as uncertain, for the
   * next engine to check — never to repeat blindly (design §6.4).
   */
  get interruptedOperation(): UncertainOperation | undefined {
    return this.cutOff;
  }

  /** The commands this run ran, with their exit codes and the end of their output. */
  get checksRun(): CheckRecord[] {
    return [...this.commandsRun];
  }


  /**
   * Things said while the run is going, waiting to be handed to the model.
   *
   * A queue rather than a single slot: three sentences typed in quick succession are
   * three separate messages to VS Code, and dropping two of them would be worse than
   * useless — the user would have no way to know which survived.
   */
  private interjections: string[] = [];

  /**
   * Why the run is ending on Clarvis's own account, when it is: a missing dependency was
   * put to the person and they chose to stop, or to install it themselves.
   */
  private halted?: string;

  /** Aborted to end the run from inside a step, alongside the caller's own Stop. */
  private halt = new AbortController();

  /** What the person already decided about a missing dependency this run, by name. */
  private readonly missingDecided = new Map<string, MissingOutcome>();

  /**
   * What this run found missing and never got past, by the command that found it.
   *
   * **Emptied only by that command succeeding.** Found live, 11 September 2026: told to
   * find another way round a missing tkinter, the model said the plan could not work
   * without it and stopped — and the run ended as a finished milestone, committed its
   * file and offered to merge it into master.
   */
  private readonly unresolved = new Map<string, MissingDependency>();

  /** Whether the model has already been told to carry out a step it only announced. */
  private nudged = false;

  /** Adds something the user said mid-run. Delivered before the next model call. */
  interject(text: string): void {
    this.interjections.push(text);
  }

  /**
   * Everything said that the model hasn't been handed yet, taken out of the run (M15 review H8).
   *
   * The loop takes interjections only between model turns, so a run that stops holds whatever was typed
   * after its last turn. Whoever ends the run takes those, rather than letting them vanish with it.
   */
  drainInterjections(): string[] {
    return this.interjections.splice(0);
  }

  /** Everything said since the last turn, as one block. Empties the queue. */
  private takeInterjections(): string {
    if (this.interjections.length === 0) return '';

    const said = this.interjections.splice(0);
    this.log(`agent: redirected mid-run — ${said.join(' / ')}`);
    return interjectionMessage(said);
  }

  /**
   * Logs an event, then hands it on.
   *
   * **Logging lives here, not in the callers.** The command path logged tool calls and
   * the chat path did not, so a run started from the chat box left no forensic trail —
   * discovered only when a run went wrong in the wrong repository and the log had
   * nothing but the branch line. Two callers doing their own logging is two callers
   * that will diverge again.
   *
   * Streamed prose is deliberately not logged: it is the model thinking out loud, it
   * arrives a token at a time, and it would bury the steps that matter.
   */
  private record(event: AgentEvent): AgentEvent {
    if (event.kind !== 'text') {
      const step = event.step ? `${event.step}. ` : '';
      // Trimmed before taking the first line: the closing note starts with a blank
      // line so it reads as a paragraph in the transcript, which made every finished
      // run log as `agent [done]` with nothing after it — the one event whose text you
      // most want in the record.
      this.log(`agent [${event.kind}] ${step}${(event.detail ?? event.text).trim().split('\n')[0]}`);
    }
    return event;
  }

  private get maxSteps(): number {
    return vscode.workspace.getConfiguration('clarvis').get<number>('agent.maxStepsPerTask', 25);
  }

  /**
   * Runs a task to completion, or until something stops it.
   *
   * An async generator so the caller streams progress without this class knowing about
   * panels or transcripts — the same shape the model stream uses, one layer up.
   */
  /**
   * Answers a question that needs to look at the project.
   *
   * The same loop and the same boundary, with three differences that matter:
   *  - **only non-mutating tools**, so a question can never become an edit
   *  - **no branch and no checkpoint**, because nothing changes and creating a branch
   *    to read a file would be absurd
   *  - **the chat model**, not the coding one — this is the cheap path, and answering
   *    "what does this file do?" at frontier prices is exactly what the two-model
   *    split exists to avoid
   */
  async *answer(
    question: string,
    signal: AbortSignal,
    addendum = ''
  ): AsyncGenerator<AgentEvent> {
    yield* this.loop(question, signal, { readOnly: true, addendum });
  }

  async *run(task: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    // A Build on's earlier run rides in the instructions, never in the task (plan.md M15).
    yield* this.loop(task, this.haltable(signal), { readOnly: false, addendum: this.engineOptions.earlierWork ?? '' });
  }

  /**
   * The caller's signal, joined to one this runner can pull itself.
   *
   * A step that learns the run cannot go on — a missing dependency the person chose to
   * install themselves — is inside the loop it would need to end, and the loop is at its
   * complexity ceiling. Aborting reuses every exit Stop already has: no further step
   * starts, no further model call is made, and `stopped()` says why.
   */
  private haltable(signal: AbortSignal): AbortSignal {
    this.halt = new AbortController();
    this.halted = undefined;
    this.unresolved.clear();
    if (signal.aborted) this.halt.abort();
    else signal.addEventListener('abort', () => this.halt.abort(), { once: true });
    return this.halt.signal;
  }

  /**
   * Undo and isolation, before the model is asked for anything.
   *
   * Established first so there is no window in which an edit could land unprotected.
   * Only for a run: a read-only answer has nothing to undo and nothing to isolate, and
   * creating a branch to read a file would be absurd.
   *
   * **Silent when it works.** The isolation branch is machinery — the user asked for a
   * change, not for a report on how it is being kept safe — and the closing line already
   * says their own work is untouched. Both failure modes are said, because each changes
   * what the result means: no isolation changes what undo covers, and isolation from the
   * wrong place changes what accepting the result would merge.
   */
  private async *protect(
    checkpoint: Checkpoint,
    branch: AgentBranch,
    task: string
  ): AsyncGenerator<AgentEvent> {
    await checkpoint.begin(task);

    // **Before the branch, and before anything runs.** Isolation protects committed
    // history; this protects what git has no copy of — the files you had open and
    // half-edited. Commands are why: an edit tool snapshots the path it is about to
    // write, and `rm -rf src` names no path at all, so it was the one thing the agent
    // could do that undo could not reverse.
    await checkpoint.captureAll(branch.atRisk());

    // **A task carried on from another engine continues on its own branch** (M15 C3, review B2), at the commit
    // that engine saved — never a new branch beside that work.
    const continuation = this.engineOptions.continueOn;
    const isolation = continuation ? await branch.continueOn(continuation) : await branch.begin(task, { fresh: this.engineOptions.startFresh });

    // Where to put the user back if they undo. Recorded after branching, because that is
    // when it is known — and recorded even when isolation failed, since the branch they
    // are on is still the branch they should end up on.
    await checkpoint.noteBranch(branch.previous);

    // **Refused continuation ends the run before anything is done.** Unlike a failed `begin`, which carries
    // on under snapshots, carrying the task on somewhere other than its branch would build on the wrong work.
    if (isolation.refused) {
      this.halted = isolation.advice ?? "The task couldn't carry on on its branch, so nothing was done.";
      this.halt.abort();
      yield this.record({ kind: 'text', toChat: true, text: this.halted });
      return;
    }
    // The branch is in place and the first model call comes next: a switch counts this run as started.
    this.engineOptions.onStarted?.();

    if (!isolation.isolated) {
      yield this.record({
        kind: 'text',
        toChat: true,
        text: `${isolation.advice ?? "I couldn't work on a copy this time."} I've snapshotted your files, so the run can still be undone.`,
      });
      return;
    }

    if (isolation.advice) yield this.record({ kind: 'text', toChat: true, text: isolation.advice });
  }

  /**
   * The brief for one turn.
   *
   * The answer shape goes *after* the addendum, so it is the last thing read before the
   * reply is written. Put anywhere earlier — including inside the character block — it
   * lost to the summarise-the-document prior a model falls into the moment tool results
   * arrive.
   */
  private systemFor(options: { readOnly: boolean; addendum: string }): string {
    // A run's skills section follows Clarvis's own rules and comes before a Build on's earlier work (plan.md §4.6,
    // "Skills"). An answer has none: `openSkills` is never called for one.
    // An invoked skill follows the list, after Clarvis's own rules in both (15 Sep 2026): never above them.
    if (!options.readOnly) return this.systemPrompt(false) + this.runSkills.section + this.invokedText + options.addendum;

    return `${this.systemPrompt(true) + this.invokedText + options.addendum}\n\n${ANSWER_SHAPE}\n\n${STATE_TAG_INSTRUCTION}`;
  }

  /**
   * The owner's skills for this run, read once at its start (plan.md §4.6, "Skills"). Nothing when no lookup was handed
   * over or the run is already stopping. One log line, and a chat line only when a failed list hid skills the owner had on
   * (`startRunSkills` decides both).
   */
  private async *openSkills(signal: AbortSignal): AsyncGenerator<AgentEvent> {
    if (!this.skills || signal.aborted) return;
    const start = await startRunSkills(this.skills(), signal);
    this.runSkills = start.skills;
    if (start.log) this.log(start.log);
    if (start.chat) yield this.record({ kind: 'text', toChat: true, text: start.chat });
  }

  /**
   * The invoked skill's section, built once as the turn begins, with its one log line of what it costs each call (the peer
   * session's rule, 15 Sep 2026). A run is also offered `readSkill`, for the rest of a cut SKILL.md and the files it points
   * to, even when the list at its start listed none. An answer never is: answers otherwise get no skills.
   */
  private openInvoked(readOnly: boolean): void {
    if (!this.invoked) return;
    const section = invokedSkillSection(this.invoked, readOnly);
    this.invokedText = section.text;
    this.log(invokedSkillLog(this.invoked, section, readOnly));
    if (!readOnly && !this.runSkills.offered) this.runSkills = { section: this.runSkills.section, offered: true, source: this.invoked.source };
  }

  /** A turn's tools: the reading tools for an answer; for a run every tool, with `readSkill` only when skills are listed. */
  private toolsFor(readOnly: boolean): ToolSchema[] {
    return readOnly ? readOnlyTools() : runTools(this.runSkills.offered);
  }

  /**
   * One more call: numbered for the transcript and the ledger, and counted against the cap unless it is one of the run's
   * free skill reads (`spendsAStep`; plan.md §4.6, "Skills").
   */
  private countCall(name: string): void {
    if (spendsAStep(name, this.skillReads)) this.steps++;
    if (name === 'readSkill') this.skillReads++;
    this.calls++;
  }

  /**
   * `readSkill`: a skill the owner switched on, read from RAVIS now. `readSkillFor` never throws; a refusal is thrown here
   * so `dispatch` logs it and hands it back as the tool result, the way every tool's failure goes back.
   */
  private async readSkill(skill: string, file: string | undefined, signal: AbortSignal): Promise<string> {
    const read = await readSkillFor(this.runSkills, skill, file, signal);
    if (!read.ok) throw new Error(read.content);
    return read.content;
  }

  /**
   * The model has stopped asking for tools, so the work is over.
   *
   * A read-only answer has nothing to commit and no branch to tidy; a run has both, and
   * the closing text carries only what the stream could not — where it left you. **Not
   * the narration**, which has already been streamed as text events and printed every
   * answer twice when it was repeated here.
   */
  /**
   * The end of a question — nothing was written, so there is nothing to say about it.
   *
   * **Was the `readOnly` half of one `completed(…, readOnly)`**, whose entire body was
   * `if (!readOnly)` four times over: two functions sharing a name and a signature.
   * §0 forbids the flag argument and says to split, and splitting is what makes it
   * visible that this path commits nothing, tidies nothing, logs nothing and says
   * nothing — it answers, and the answer already went out as it streamed.
   *
   * `files` is still reported: a question is offered read-only tools, but which files
   * it read is worth knowing and the ledger records it.
   */
  private completedAnswer(): AgentEvent {
    return { kind: 'done', text: '', closing: undefined, files: [...this.touched] };
  }

  /** The end of a task: commit what was kept, tidy what was not, and say what he said. */
  private async completedRun(branch: AgentBranch, task: string, narration: string): Promise<AgentEvent> {
    await this.finish(branch, task, narration);
    // Nothing was kept, so the isolation branch is clutter. Tidied here rather than
    // left for the review wizard, which would otherwise offer five options about an
    // empty branch.
    this.tidied = await this.tidy(branch);

    // **What he actually said, in the conversation.** Narration went to the terminal
    // only, and the chat got the branch note — so a run that ended by asking four
    // questions ("Suggestions shown as a preview, or applied straight away?") put
    // them where nobody was looking, and the panel showed a line about branches.
    // Questions the agent needs answered are the whole point of it asking.
    this.log(`agent: finished with ${narration.trim() ? 'a message' : 'nothing to say'}`);

    // **Kept apart, because folding them together hid a silent run.** The closing note
    // is about branches — "your own work on `master` is untouched" — and joining it to
    // the narration made an empty narration look like a summary to the caller, which
    // has an honest line ready for exactly that case and never got to use it. Found
    // live: nine steps, no files, nothing said, and the chat showed a note about
    // branches followed by an aside about the hard part being over.
    return {
      kind: 'done',
      text: this.lostProject ? TAKEN_OVER_LINE : narration.trim(),
      closing: this.closingNote(branch) || undefined,
      files: [...this.touched],
    };
  }

  /**
   * The three reasons a run never starts, in the order they can be checked.
   *
   * Together rather than scattered through `loop`: they share a shape — decide, say why,
   * stop — and interleaving them with the setup is what let a cancelled run create a
   * checkpoint and a branch before noticing it had been cancelled.
   */
  private async refuseToStart(role: 'chat' | 'agent', signal: AbortSignal): Promise<AgentEvent | undefined> {
    if (!this.root) {
      return {
        kind: 'error',
        text: await phrase('report', 'There is no folder open, so there is nothing to work on.'),
      };
    }

    if (!(await this.models.isReady(role))) {
      const provider = this.models.spec(role);
      return {
        kind: 'error',
        text: `The coding model isn't configured — ${provider.label} has no key. API config, in the bowtie menu by the prompt, sorts that out.`,
      };
    }

    // Stop pressed while the opening line was still being written used to leave the run
    // to start anyway: checkpoint, branch, checkout, and only then the first look at the
    // signal. The user was left standing on an empty branch they had just asked not to
    // exist.
    if (signal.aborted) {
      this.log('agent: cancelled before any setup');
      return { kind: 'done', text: 'Stopped.', files: [] };
    }

    return undefined;
  }

  /**
   * Leaving cleanly: what the run wrote is committed to its own branch, and the branch is
   * tidied if that left it holding nothing.
   *
   * **Committed, not abandoned.** Found live, 11 September 2026: a milestone run was
   * stopped after writing `timer.py`, nothing was committed, and every later run found
   * an uncommitted file that existed before it started — "those stay the user's" — so
   * nothing in the project was ever committed. What a stopped run wrote is still the
   * run's own work, and a commit on its branch is what makes it reviewable and undoable.
   */
  private async stopped(branch: AgentBranch, task: string): Promise<AgentEvent> {
    await this.finish(branch, task, this.halted ? 'Stopped at a missing dependency' : 'Stopped before finishing');
    this.tidied = await this.tidy(branch);
    return { kind: 'done', text: this.halted ?? 'Stopped.', files: [...this.touched] };
  }

  /**
   * Runs the tools the model asked for, reporting each as it goes.
   *
   * A generator that *returns* its results as well as yielding events, so the caller
   * gets both without a shared array to fill in — `const results = yield* this.runCalls(…)`.
   */
  private async *runCalls(
    calls: ToolCall[],
    checkpoint: Checkpoint,
    signal: AbortSignal
  ): AsyncGenerator<AgentEvent, ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of calls) {
      if (signal.aborted) break;

      // **A skill read within the run's free reads spends no step** (plan.md §4.6, "Skills"), though every call is still
      // numbered, so the transcript and the ledger stay in order.
      this.countCall(call.name);
      const args = (call.args ?? {}) as Record<string, unknown>;

      yield this.record({
        kind: 'tool',
        text: isToolName(call.name) ? narrateTool(call.name, args) : `Asking for ${call.name}`,
        detail: describe(call),
        quiet: isToolName(call.name) && isLookingAround(call.name, args),
        // **Edits are said out loud; looking around is not.** "Nothing technical
        // reaches the chat" is about tool calls and command output, not about the
        // one thing the user most wants narrated — which file is being changed, as
        // it changes. Reads, searches and `git status` stay in the terminal, or the
        // transcript becomes the log it was split away from.
        toChat: isToolName(call.name) && changesAFile(call.name),
        step: this.calls,
      });

      // **Asked before it happens, not reported after.** The narration above says
      // what is about to be done; this is where the user gets to say no to it. The
      // deny-list gate (below, in `runCommand`) is a different thing and stays: that
      // one fires on what is dangerous, this one on what is about to change
      // anything at all.
      const acting = isToolName(call.name) && !isLookingAround(call.name, args);
      if (this.approveStep && acting) {
        // **What it does, not what it is called.** This used to hand over
        // `describe(call)` — `runCommand: python3 -m pip install pillow` — which is a
        // log line, and being asked to approve one means already knowing the answer.
        const step = explainStep(call.name, args);
        const description = step.title;
        // **Marked even in the modes that answer instantly.** `approveStep` returns
        // straight away when the mode says not to ask, so Auto and Unattended
        // produce a `waiting_for_approval` that lasts less than a millisecond. Only
        // wrong if someone reads the state inside that window, and the alternative
        // — guessing here whether the callback will actually ask — is a copy of the
        // mode rules in a second place, which is how the two stop agreeing.
        const approved = await whileAwaiting(this.activity, 'step', () => this.approveStep!(step));
        // **Stop wins over the answer.** Reported 11 September 2026: Stop pressed while
        // this waited stopped nothing until someone answered. Stop now releases the
        // question, which comes back unanswered — and a "Do it" that raced the stop must
        // not start the step either. Breaking out leaves `loop` to notice the abort and
        // report the stop, as it does between steps.
        const next = stepAfterAsking(approved, signal.aborted);
        if (next === 'stop') break;
        if (next === 'skip') {
          this.log(`agent [declined] ${description}`);
          const declined = 'The user declined that step. Do not retry it — find another way, or stop and say what you would have done.';
          results.push({ id: call.id, content: declined, isError: true });
          yield this.record({ kind: 'gate', text: `Skipped: ${description}`, toChat: true });
          continue;
        }
      }

      const result = await this.dispatch(call, checkpoint, signal);
      results.push(result);

      if (result.isError) yield this.record({ kind: 'gate', text: result.content });
    }

    return results;
  }

  /**
   * Run under a trace the caller already has.
   *
   * `withTools` starts the activity *before* constructing this runner, so a
   * trace minted inside `loop` arrives after `clarvis.chat.started` has already
   * been published — the start event carried no trace and the completion
   * carried one, which is a span with only half its ends. The caller mints
   * first and tells the runner.
   */
  /**
   * A skill the owner invoked with a slash command, **loaded up front** (the owner's decision, 15 Sep 2026): its SKILL.md
   * goes into this run's or answer's instructions before the first model call, so the model doesn't have to choose it.
   * Set before `run` or `answer`, as `useTrace` is.
   */
  invokeSkill(invoked: InvokedSkill): void {
    this.invoked = invoked;
  }

  useTrace(traceId: string): void {
    this.givenTrace = traceId;
  }

  private givenTrace = '';

  /**
   * Refuse the run, or set up the two things that make it undoable.
   *
   * **Lifted out of `loop` to bring it back under the complexity ceiling (§16
   * item 11).** Not a split for the metric's sake: this is one question with one
   * answer — may this run start, and if so under what protection — and `loop`
   * below is about the step cycle rather than about getting to it.
   *
   * Returns `null` when the run was refused, having already yielded the reason,
   * so the caller's check reads as "did it start" rather than as a second copy
   * of the refusal logic.
   */
  private async *begin(
    role: 'chat' | 'agent',
    signal: AbortSignal,
    options: { readOnly: boolean; addendum: string },
    task: string
  ): AsyncGenerator<AgentEvent, { checkpoint: Checkpoint; branch: AgentBranch } | null> {
    const refusal = await this.refuseToStart(role, signal);
    if (refusal) {
      yield this.record(refusal);
      return null;
    }

    // Isolation and undo are established *before* the model is asked for anything, so
    // there is no window in which an edit could land unprotected. Neither is set up for
    // a read-only answer: there is nothing to undo and nothing to isolate.
    const checkpoint = new Checkpoint(this.context, this.root, this.log);
    const branch = new AgentBranch(this.log, this.context.workspaceState);
    // Held so the caller can ask afterwards where the work ended up — the run is over
    // by the time "shall I fold this back in?" is worth asking.
    this.lastBranch = branch;

    if (!options.readOnly) {
      yield* this.protect(checkpoint, branch, task);
      // With the branch in place and before the first model call: the list is read once, for this run alone.
      yield* this.openSkills(signal);
    }
    this.openInvoked(options.readOnly);
    return { checkpoint, branch };
  }

  private async *loop(
    task: string,
    signal: AbortSignal,
    options: { readOnly: boolean; addendum: string }
  ): AsyncGenerator<AgentEvent> {
    // **The two things a turn's mode actually decides**, side by side rather than as
    // ternaries forty lines apart: which model answers, and how many steps it may take.
    // A question that needs a dozen tool calls has become a task, and capping it lower
    // keeps an answer from quietly costing what a run costs.
    const { role, cap } = options.readOnly
      ? { role: 'chat' as const, cap: Math.min(this.maxSteps, 10) }
      : { role: 'agent' as const, cap: this.maxSteps };

    const started = yield* this.begin(role, signal, options, task);
    if (!started) return;
    const { checkpoint, branch } = started;

    const messages: ModelMessage[] = [{ role: 'user', content: task }];

    // **One trace for the whole run, not one per step.** §8's fourth acceptance
    // scenario asks that an agent run preserve trace lineage, and a run is a
    // dozen model calls deciding one task — separate traces would put each step
    // in its own waterfall and lose the only thing worth seeing, which is how
    // the steps followed each other.
    // A caller that already started the activity supplies its trace, so the
    // `started` event and the steps name the same operation. Minted here only
    // when nobody did — the palette route starts a run without one.
    const traceId = this.givenTrace || newTraceId();
    // With the session this loop's requests carry, which depends on the role:
    // a read-only answer runs on the chat model, a job on the agent's.
    this.activity?.noteTrace(traceId, this.models.sessionFor(role));

    while (this.steps < cap) {
      if (signal.aborted) {
        yield this.record(await this.stopped(branch, task));
        return;
      }

      const calls: ToolCall[] = [];
      let narration = '';
      // **Buffers the head so a leading `[[state]]` tag never reaches a `text` event.**
      // The earlier fix stripped the *logged* copy of the narration after the loop below
      // had already finished — by which point every fragment had been yielded and was on
      // screen. This is the same problem the reply path solved with the same class: strip
      // before the first fragment leaves, not after the last one arrives. Found live,
      // 20 Aug, on the very build that shipped the first fix — a post-hoc strip is not the
      // same guarantee as never emitting the tag.
      const reader = new ReplyStateReader();

      try {
        for await (const event of this.models.streamWithTools(
          {
            system: this.systemFor(options),
            messages,
            signal,
            tools: this.toolsFor(options.readOnly),
            traceId,
          },
          role
        )) {
          const outcome = absorbStreamEvent(event, calls, reader, narration);
          narration = outcome.narration;
          if (outcome.visible) yield { kind: 'text', text: outcome.visible };
        }
      } catch (error) {
        if (signal.aborted) {
          yield this.record(await this.stopped(branch, task));
          return;
        }
        yield this.record({ kind: 'error', text: `The model gave up: ${String(error)}` });
        return;
      }

      narration = this.takeWrittenCalls(calls, narration);

      // No tool calls means the model considers the task finished — unless all it said
      // was which step it was about to begin.
      if (calls.length === 0) {
        if (this.nudgedPastAnnouncement(narration, messages, options.readOnly)) continue;
        yield this.record(await this.endOfTurn(branch, task, narration, options.readOnly));
        return;
      }

      messages.push({ role: 'assistant', content: narration, toolCalls: calls });
      const results = yield* this.runCalls(calls, checkpoint, signal);

      // **Anything said mid-run rides in with the tool results.** Stopping and
      // restarting would throw away everything read so far and make "no, use the
      // other library" cost a whole run; this arrives as the next thing in the
      // conversation, which is what it is.
      const redirect = this.takeInterjections();
      messages.push({ role: 'user', content: redirect, toolResults: results });
    }

    // The cap is a stop-and-ask, not a failure: a long task is not a wrong one, but a
    // loop that never converges must not run up a bill unattended.
    this.stepCapped = true;
    yield this.record({
      kind: 'done',
      text: `I've used ${this.steps} steps without finishing. Say "carry on" if it's going well, or stop me here.`,
      files: [...this.touched],
    });
  }

  /**
   * Runs one tool call.
   *
   * Every failure becomes a **tool result**, never an exception: an agent told "that
   * text appears three times" fixes its next call, whereas one handed a crash ends the
   * run and leaves the work half-done.
   */
  private async dispatch(
    call: ToolCall,
    checkpoint: Checkpoint,
    signal: AbortSignal
  ): Promise<ToolResult> {
    if (!isToolName(call.name)) {
      this.log(`agent [refused] unknown tool "${call.name}"`);
      return { id: call.id, content: `There is no tool called "${call.name}".`, isError: true };
    }

    const name: ToolName = call.name;
    const validation = validateArgs(name, call.args);
    if (!validation.ok) {
      return { id: call.id, content: validation.error, isError: true };
    }

    const args = call.args as Record<string, string & boolean>;

    // **The fence** (M15 C2a): a call that writes goes ahead only while this run still holds the
    // project. Lost to another window, the run ends here and writes nothing more.
    if (!(await this.mayWrite(mutates(name)))) {
      return { id: call.id, content: TAKEN_OVER_TOOL_RESULT, isError: true };
    }

    try {
      // Snapshot before the change, not after — the whole point of undo.
      if (mutates(name) && typeof args.path === 'string') {
        await checkpoint.capture(await resolveInWorkspace(this.root, args.path));
      }

      const content = await this.whileUnderWay(call, name, signal, () => this.invoke(name, args, signal));

      // Recorded from the resolved path rather than the requested one: on a
      // case-insensitive filesystem `readme.md` edits README.md, and committing the
      // requested spelling fails because git is case-sensitive.
      if (mutates(name) && typeof args.path === 'string') {
        this.touched.add(await canonicalRelative(this.root!, await resolveInWorkspace(this.root, args.path)));
      }

      return { id: call.id, content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`agent [failed] ${name} — ${message}`);
      return { id: call.id, content: message, isError: true };
    }
  }

  private async invoke(
    name: ToolName,
    args: Record<string, string & boolean>,
    signal: AbortSignal
  ): Promise<string> {
    // A table rather than a chain of nine `if`s. Each entry is the whole of what that
    // tool does, so a new tool is one line here plus its entry in the registry — and
    // there is no order to get wrong.
    const tools: Record<ToolName, () => Promise<string> | string> = {
      readFile: async () => {
        await this.gateSensitiveRead(args.path);
        const result = await readFile(this.root, args.path);
        return result.truncated ? `${result.text}\n\n[truncated at 512KB]` : result.text;
      },

      listFiles: async () => {
        const files = await listFiles(this.root, {
          directory: args.directory,
          recursive: args.recursive !== false,
        });
        return files.join('\n') || '(no files)';
      },

      search: async () => {
        const hits = await search(this.root, new RegExp(args.pattern), { directory: args.directory });
        return hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`).join('\n') || '(no matches)';
      },

      applyEdit: async () => {
        const outcome = await applyEdit(this.root, args.path, args.find, args.replace);
        return `Edited ${outcome.file}, ${outcome.changedLines} line(s) changed.`;
      },

      writeFile: async () => {
        const outcome = await writeFile(this.root, args.path, args.contents);
        return `${outcome.created ? 'Created' : 'Rewrote'} ${outcome.file}.`;
      },

      runCommand: () => this.runGated(args.command, signal),

      readDiagnostics: () => readDiagnostics(this.root, args.file).join('\n') || '(no problems reported)',

      gitStatus: () => gitStatus(),
      gitDiff: async () => (await gitDiff(args.staged === true)) || '(no changes)',

      readSkill: () => this.readSkill(args.skill, args.file, signal),
    };

    return tools[name]?.() ?? 'Nothing happened.';
  }

  /**
   * Runs a command, asking first when the deny-list says so.
   *
   * The gate is checked **here**, not in the prompt: the model is never told "you may
   * run this if the user agrees", it simply cannot proceed without an approval this
   * code obtained. A refusal comes back as an ordinary tool result so the model can
   * pick a different approach rather than stalling.
   */
  /**
   * The gate dialog, and what came back.
   *
   * Separate from `runGated` because the sandbox escape adds a third answer, and three
   * answers plus the spawn decision plus the run itself put one method four branches
   * over the complexity ceiling — the sort of growth that is invisible until something
   * measures it.
   */
  private async askGate(
    command: string,
    verdict: GateVerdict,
    confined: boolean
  ): Promise<'approved' | 'unconfined' | 'refused'> {
    const label = approveLabel(verdict);
    // Offered only where the sandbox is the actual obstacle, and only while there is
    // one to step out of.
    const escape = confined && mayEscapeConfinement(verdict) ? ESCAPE_LABEL : undefined;

    const approved = await whileAwaiting(this.activity, 'command', () =>
      vscode.window.showWarningMessage(
        explainGate(command, verdict, Boolean(escape)),
        { modal: true },
        ...(escape ? [label, escape] : [label])
      )
    );

    if (approved !== label && approved !== escape) {
      this.log(`gate: refused "${command}" (${verdict.category})`);
      return 'refused';
    }

    this.log(`gate: approved "${command}" (${verdict.category})`);
    if (approved !== escape) return 'approved';

    // Per command, never stored: the next install asks again from scratch. A
    // remembered "yes, unconfined" is an unconfined agent with extra steps.
    this.log(`sandbox: "${command}" allowed out of the sandbox for this one run`);
    return 'unconfined';
  }

  /**
   * Why an unconfined command is not going to run, if it is not.
   *
   * Three outcomes rather than two, because "go and install the sandbox" is neither a
   * yes nor a no — it is a request to ask again shortly, and reporting it as a refusal
   * would have the model looking for another way round a door that is being unlocked.
   */
  private async unconfinedRefusal(command: string): Promise<string | undefined> {
    const answer = await mayRunUnconfined(this.context, this.log);

    if (answer === 'installing') {
      this.log(`sandbox: holding "${command}" while bubblewrap is installed`);
      return [
        "I've opened a terminal with the bubblewrap install line ready — press Enter there and give your password.",
        'Once it finishes, tell me and I will try again with commands properly confined.',
        "Don't retry this command in the meantime.",
      ].join(' ');
    }

    if (answer === 'refused') {
      this.log(`sandbox: refused "${command}" — no sandbox and unconfined commands declined here`);
      return "I can't run commands in this folder: there's no sandbox on this machine and you asked me not to run them unconfined. Everything else still works.";
    }

    return undefined;
  }

  /**
   * The one deliberate exception to "reads are never gated" (§4.6).
   *
   * The workspace boundary is a location boundary, not a sensitivity one: `.env` is
   * exactly as readable as `README.md` unless something says otherwise. This is that
   * something, and — like the deny-list gate for commands — it fires **regardless of
   * mode**: Auto and Unattended both skip ordinary step approval on purpose, but
   * neither is a decision to hand a private key to a model unattended. So this is a
   * `showWarningMessage`, not the `approveStep` callback that mode already bypasses.
   */
  private async gateSensitiveRead(requestedPath: string): Promise<void> {
    const verdict = classifyPath(requestedPath);
    if (!verdict) return;

    const strong = verdict.category === 'key';
    const approved = await whileAwaiting(this.activity, 'sensitive_read', () =>
      vscode.window.showWarningMessage(
        strong
          ? `${requestedPath} looks like ${verdict.what}. Reading it hands the actual key to the model.`
          : `${requestedPath} looks like ${verdict.what}. Reading it may hand a live credential to the model.`,
        {
          modal: true,
          detail: `Worst case: ${verdict.worstCase}.${strong ? ' Only approve this if you are certain.' : ''}`,
        },
        strong ? 'Read it anyway' : 'Read it'
      )
    );

    if (approved === undefined) {
      this.log(`agent [refused] sensitive read: ${requestedPath} (${verdict.category})`);
      throw new Error(
        `The user did not approve reading ${requestedPath}. Do not retry it — work around it, or ask what to do instead.`
      );
    }

    this.log(`agent: approved sensitive read: ${requestedPath} (${verdict.category})`);
  }

  private async runGated(command: string, signal: AbortSignal): Promise<string> {
    const verdict = classifyCommand(command);

    const allowNetwork = allowsNetwork(verdict);

    // **Confined where the machine can confine it.** Worked out before the gate rather
    // than after it, because whether the sandbox is standing there changes what the
    // gate can offer — an install it is about to confine has a second answer worth
    // giving. Without a sandbox the user has already been asked, once for this
    // workspace, whether unconfined commands are acceptable; declining leaves reading,
    // answering, planning and editing intact, which is most of the product.
    let escaped = false;
    let spawnAs = await spawnFor(
      command,
      this.root ?? '',
      path.join(this.context.globalStorageUri.fsPath, 'sandbox'),
      this.log,
      allowNetwork
    );

    if (verdict) {
      const answer = await this.askGate(command, verdict, spawnAs.confined);
      // The decision itself lives in `gateDecision.ts`, where a test can reach it:
      // this method is private on a class that imports `vscode`, so the branch the
      // gate exists for was the one branch nothing could exercise.
      const outcome = gateOutcome(verdict, answer, spawnAs.confined);
      if (!outcome.run) return String(outcome.toldTheModel);
      escaped = outcome.escapes;
      if (escaped) spawnAs = { file: command, args: [], confined: false };
    }

    // Not asked when the user just chose this at the gate — "there's no sandbox on
    // this machine, run anyway?" is a strange thing to say to someone who has this
    // second stepped out of the one that is plainly working.
    const refusal =
      spawnAs.confined || escaped ? undefined : await this.unconfinedRefusal(command);
    if (refusal) return refusal;

    this.terminal.announce(command);
    // **Both paths logged, not just the bad one.** The first version logged only when
    // a command ran unconfined, so a confined run said nothing — and silence is also
    // what "the sandbox code never executed" looks like. The first live run could not
    // be told apart from the feature being absent. Exactly the mistake the briefing
    // made when it logged "from the bank" for three different reasons.
    this.log(
      spawnAs.confined
        ? `sandbox: confined by ${spawnAs.via} — writes limited to the workspace`
        : escaped
          ? 'sandbox: running unconfined — approved for this command only'
          : 'sandbox: running unconfined (allowed for this workspace)'
    );

    const result = await this.runReported(command, signal, spawnAs);

    const note = confinementNote(spawnAs.confined, result.exitCode, result.output, allowNetwork);
    if (note) this.log(`sandbox: "${command}" failed on something the confinement denied`);

    return this.reportCommand(command, result, note);
  }

  /**
   * What the model is told a command did — and, when it found something missing from
   * this computer, what the person decided to do about it.
   *
   * **Asked in every mode, the way the deny-list is.** Found live, 11 September 2026:
   * `import tkinter` failed because this machine's Python was built without it, and the
   * run carried on — it tried to reinstall Python, ticked steps whose checks never ran and
   * rewrote the plan around the gap. A missing piece of the machine is a question for its
   * owner, not something to work around, and Unattended is no reason to skip asking.
   */
  private async reportCommand(command: string, result: CommandResult, note: string | undefined): Promise<string> {
    const said = [
      `exit ${result.exitCode ?? 'killed'}${result.timedOut ? ' (timed out)' : ''}`,
      result.output.trim() || '(no output)',
      ...(note ? ['', note] : []),
    ].join('\n');

    const missing = missingDependency(result.output, result.exitCode);
    if (!missing) {
      if (result.exitCode === 0) this.unresolved.delete(command);
      await this.settleBlocker(command, result.exitCode);
      return said;
    }
    return `${said}\n\n${await this.askMissing(command, missing)}`;
  }

  /**
   * Puts a missing dependency to the person, and ends the run when that is their answer.
   *
   * **Once per thing per run.** Told to find another way, a model that tries the same
   * import again should hear the same answer, not raise the same dialog.
   */
  private async askMissing(command: string, missing: MissingDependency): Promise<string> {
    const earlier = this.missingDecided.get(missing.name);
    if (earlier?.decision === 'another-way') {
      this.unresolved.set(command, missing);
      return earlier.toldTheModel;
    }

    this.log(`agent: "${command}" found ${missing.name} missing (${missing.kind}) — asking what to do`);
    const answer = await whileAwaiting(this.activity, 'other', () =>
      vscode.window.showWarningMessage(explainMissing(command, missing), { modal: true }, ...missingOptions(missing))
    );
    const outcome = missingOutcome(missing, answer);
    this.missingDecided.set(missing.name, outcome);
    if (!outcome.halt) this.unresolved.set(command, missing);
    this.log(`agent: missing ${missing.name} — ${outcome.decision}`);
    await this.context.workspaceState.update(
      BLOCKER_KEY,
      blockerRecord(command, missing, outcome.decision, Date.now())
    );
    if (outcome.halt) {
      this.halted = outcome.halt;
      this.halt.abort();
    }
    return outcome.toldTheModel;
  }

  /** Forgets a remembered missing dependency once the command that found it succeeds. */
  private async settleBlocker(command: string, exitCode: number | undefined): Promise<void> {
    const record = activeBlocker(this.context.workspaceState.get(BLOCKER_KEY), Date.now());
    if (!clearsBlocker(record, command, exitCode)) return;
    await this.context.workspaceState.update(BLOCKER_KEY, undefined);
    this.log(`agent: "${command}" works now — the missing-dependency note is cleared`);
  }

  /**
   * The closing line, which must say **where the user now is**.
   *
   * Creating a branch checks it out, so a finished run leaves the editor on
   * `clarvis/<task>` rather than where it started. Not saying so is how someone
   * commits their next hour of work onto an agent's branch without noticing.
   */
  private closingNote(branch: AgentBranch): string {
    // A run that created a branch, used it for nothing and removed it again is
    // bookkeeping, and narrating bookkeeping is how a tool sounds busy rather than
    // useful.
    if (this.tidied || !branch.current) return '';

    // Plain, and short. The previous version — "you're now on X (was Y), review the
    // diff, then merge it or throw it away" — is three git instructions to someone who
    // may not know what a diff is, and the decision is offered by a button anyway.
    //
    // A file the user was already editing is the exception worth a second sentence:
    // it is the one case where their work and mine are tangled together in the same
    // file, and staying quiet about that is how someone loses track of which is which.
    const tangled = explainHeldBack(branch.heldBack);

    return (
      `\n\nYour own work on \`${branch.previous}\` is untouched — my changes are on a temp branch.` +
      (tangled ? `\n\n${tangled}` : '')
    );
  }

  /**
   * Tool calls the model wrote out as text, moved into `calls`; returns what is left to say.
   *
   * **A tool call written out as text is still a tool call.** Found live, 11 September
   * 2026: one reply carried `<function=listFiles>` in its text and no structured call,
   * and the run ended after 0 steps with the markup on screen. Its own method because
   * the loop is at the complexity ceiling `eslint.config.mjs` enforces.
   */
  private takeWrittenCalls(calls: ToolCall[], narration: string): string {
    if (calls.length > 0) return narration;
    const written = toolCallsInText(narration);
    if (written.calls.length === 0) return narration;
    this.log(`agent: ${written.calls.length} tool call(s) arrived as text — reading them as calls`);
    calls.push(...written.calls);
    return written.rest;
  }

  /**
   * The model announced a step and stopped there; asks it, once, to do the step.
   *
   * Found live, 11 September 2026: "continue building" produced a single line — `STEP: Add
   * a label showing the timer state` — and no tool call, so the run ended after one step
   * with "I stopped without changing anything". Announcing is half of what the brief asks;
   * doing only that half is not the model deciding the work is done.
   */
  private nudgedPastAnnouncement(narration: string, messages: ModelMessage[], readOnly: boolean): boolean {
    if (readOnly || this.nudged || !announcesStep(stripTags(narration))) return false;
    this.nudged = true;
    this.log('agent: the reply only announced a step — asking the model to carry it out');
    messages.push({ role: 'assistant', content: narration });
    messages.push({ role: 'user', content: 'You announced the step but did not do it. Carry it out now, using the tools.' });
    return true;
  }

  /** The end of a turn with no tool calls: the run, or the answer, is over. */
  private async endOfTurn(branch: AgentBranch, task: string, narration: string, readOnly: boolean): Promise<AgentEvent> {
    // **The expression marker is for the face, never for the reader.** This prompt
    // asks for a `[[state]]` tag and the streaming reply path consumes one — but the
    // closing narration leaves through a `done` event, which that path forwards
    // untouched on the rule that tool lines are ours rather than the model's. This
    // one is the model's, so it arrived on screen with `[[talking]]` still on the
    // front of it. Found live, 20 Aug, and it makes a liar of §7's checklist item
    // saying the tag never appears in reply text — true of one path, not both.
    // The reader may still hold a tag that arrived too late to flush as a `text`
    // event (the stream ended before HEAD_CHARS was reached). One more pass over the
    // full narration guarantees it never survives into the log or the summary either.
    const said = stripTags(narration).trimStart();
    // **Why it stopped, in the log.** A run that ended after two reads with an
    // empty summary left nothing to diagnose from — found live, and the closing
    // line then invented a conclusion to fill the silence. Narration is what the
    // model said for itself before deciding it was done.
    this.log(
      `agent: model stopped after ${this.steps} step(s), ${this.touched.size} file(s) touched — said: ${JSON.stringify(said.trim() || '(nothing)')}`
    );
    return readOnly ? this.completedAnswer() : this.completedRun(branch, task, said);
  }

  /** Commits the run's own files onto its own branch, if there was anything to commit. */
  private async finish(branch: AgentBranch, task: string, narration: string): Promise<void> {
    if (this.touched.size === 0 || !branch.current) return;
    // The fence, before the write that matters most: a run another window took over commits nothing.
    if (!(await mayCommitNow(this.fence))) return this.takenOver();

    // Workspace-relative, deliberately: this is the form the run records and the form
    // the "already modified before we started" check compares against. AgentBranch
    // makes them absolute for git at the last moment.
    const summary = commitSubject(narration, task);

    const hash = await branch.commit(`${summary}\n\nTask: ${task}`, [...this.touched]);
    if (hash) this.ownCommits.push(hash);
  }

  /** Whether another window has taken this run's project (M15 C2a). Once true, nothing more is written. */
  private lostProject = false;

  /** Whether a call may go ahead under the fence. The first refusal ends the run. */
  private async mayWrite(writes: boolean): Promise<boolean> {
    if (await mayWriteNow(this.fence, writes)) return true;
    this.takenOver();
    return false;
  }

  /**
   * Another window took the project: halt, so the loop leaves by the exit Stop already has, and say why.
   * `halted` also marks the run blocked, so nothing offers to review or land work it didn't finish.
   */
  private takenOver(): void {
    if (this.lostProject) return;
    this.lostProject = true;
    this.log('agent: another window took over this project — stopping, and writing nothing more');
    this.halted = TAKEN_OVER_LINE;
    this.halt.abort();
  }

  /** Removes an empty run branch — never once the project was taken over: git is written to as well. */
  private async tidy(branch: AgentBranch): Promise<boolean> {
    return !this.lostProject && (await branch.discardIfEmpty());
  }

  /** Bumped when a command starts and when it ends, so a late `ps` answer can't name a finished command. */
  private commandSeq = 0;

  /**
   * Runs a command, telling the fence which process group it is while it runs (M15 C2a; final check
   * F-A4), so a window taking the project over could stop exactly that group.
   */
  private async runReported(command: string, signal: AbortSignal, spawnAs: Parameters<typeof runCommand>[4]): Promise<CommandResult> {
    const seq = ++this.commandSeq;
    try {
      const echo = (chunk: string) => this.terminal.write(chunk);
      const result = await runCommand(this.root, command, echo, signal, spawnAs, (pid) => void this.reportRunning(seq, pid));
      // Kept for the checkpoint (M15 C3): what ran and how it ended, the end of its output only.
      this.commandsRun.push({ command, exitCode: result.exitCode ?? null, engine: 'clarvis', ranAt: new Date().toISOString(), outputTail: result.output.slice(-1_500) });
      return result;
    } finally {
      this.commandSeq++;
      this.fence?.commandEnded();
    }
  }

  /**
   * A tool call that changes something, watched while it runs: cut off by a stop, it is remembered as uncertain —
   * it may or may not have happened — so a switch hands it on as something to check, never to redo (M15 C3).
   */
  private async whileUnderWay(call: ToolCall, name: ToolName, signal: AbortSignal, work: () => Promise<string>): Promise<string> {
    if (!mutates(name)) return work();
    try {
      return await work();
    } finally {
      if (signal.aborted) this.cutOff = { kind: name === 'runCommand' ? 'command' : 'fileChange', summary: describe(call), state: 'unknown' };
    }
  }

  private async reportRunning(seq: number, pid: number | undefined): Promise<void> {
    if (!this.fence || pid === undefined) return;
    const described = await describeProcess(pid);
    if (seq !== this.commandSeq || !described) return;
    // Spawned detached, in its own process group, so the group id is the pid.
    this.fence.commandStarted({ pid, pgid: pid, start: described.start, comm: described.comm });
  }

  /** What this run committed and touched, for the review wizard. */
  /** The branch object from the last run, for the questions that come after it. */
  private lastBranch?: AgentBranch;

  /**
   * The branch this run worked on, and the one it came from.
   *
   * Exposed because the end of a run is where "shall I fold this back in?" belongs,
   * and the caller cannot answer that without knowing both names.
   */
  get branches(): { working?: string; startedFrom?: string } {
    return { working: this.lastBranch?.current, startedFrom: this.lastBranch?.previous };
  }

  get result(): { commits: string[]; files: string[] } {
    return { commits: [...this.ownCommits], files: [...this.touched] };
  }

  /** Whether the run ended at a missing dependency — which is not a finished milestone. */
  get blocked(): boolean {
    return this.halted !== undefined || this.unresolved.size > 0;
  }

  /**
   * Whether the run ended because it used every step it was allowed — which is not a
   * finished milestone either. The Codex engine reports the same from RAVIS's step cap.
   */
  get endedAtStepCap(): boolean {
    return this.stepCapped;
  }

  /**
   * What is still missing when the run went on past the question and never got past it,
   * for the offer that follows. Not for a run the user ended there themselves.
   */
  get stillMissing(): MissingDependency | undefined {
    return this.halted ? undefined : this.unresolved.values().next().value;
  }

  /**
   * The agent's instructions.
   *
   * States the constraints the *code* enforces, so the model's expectations match
   * reality — a model that believes it can reach outside the workspace wastes steps
   * discovering otherwise. It is not where the constraints live.
   */
  private systemPrompt(readOnly = false): string {
    return agentSystemPrompt(readOnly, this.root);
  }
}

/**
 * The agent's brief, outside the class so the voice check can send the real one.
 *
 * A harness that reconstructs the prompt it is testing tests nothing: the copy drifts,
 * and the version that drifted is the one nobody read. So there is one definition and
 * both callers use it.
 */

/** One readable line per tool call, for the panel. */
function describe(call: ToolCall): string {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const detail = args.path ?? args.command ?? args.pattern ?? args.directory ?? skillCallDetail(args);

  return detail ? `${call.name}: ${String(detail)}` : call.name;
}

export { agentSystemPrompt };
