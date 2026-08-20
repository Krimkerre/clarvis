import * as vscode from 'vscode';
import { ModelService } from '../model/ModelService';
import { ModelMessage, ToolCall, ToolResult } from '../model/ModelProvider';
import { isToolName, mutates, validateArgs, readOnlyTools, ToolName } from './toolRegistry';
import { explainStep, StepExplanation } from './stepExplanation';
import { agentSystemPrompt } from './agentPrompt';
import { changesAFile, isLookingAround, narrateTool } from './toolNarration';
import { interjectionMessage } from './interjections';
import { commitSubject } from './commitSubject';
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
import { Checkpoint } from './Checkpoint';
import { AgentBranch } from './AgentBranch';
import { readFile, listFiles, search } from './tools/fileTools';
import { applyEdit, writeFile } from './tools/editTools';
import { AgentTerminal, gitDiff, gitStatus, readDiagnostics, runCommand } from './tools/commandTools';
import { mayRunUnconfined, spawnFor } from './tools/sandbox';
import { confinementNote } from './tools/confinement';
import * as path from 'path';
import { canonicalRelative, resolveInWorkspace } from './tools/workspacePaths';
import { explainHeldBack } from './dirtyAtStart';
import { ANSWER_SHAPE } from '../personality/character';
import { STATE_TAG_INSTRUCTION, stripTags } from '../chat/replyState';

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
  kind: 'text' | 'tool' | 'gate' | 'done' | 'error';
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

export class AgentRunner {
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
  private steps = 0;

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
    private readonly approveStep?: (step: StepExplanation) => Promise<boolean>
  ) {}

  /**
   * Things said while the run is going, waiting to be handed to the model.
   *
   * A queue rather than a single slot: three sentences typed in quick succession are
   * three separate messages to VS Code, and dropping two of them would be worse than
   * useless — the user would have no way to know which survived.
   */
  private interjections: string[] = [];

  /** Adds something the user said mid-run. Delivered before the next model call. */
  interject(text: string): void {
    this.interjections.push(text);
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
    yield* this.loop(task, signal, { readOnly: false, addendum: '' });
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

    const isolation = await branch.begin(task);

    // Where to put the user back if they undo. Recorded after branching, because that is
    // when it is known — and recorded even when isolation failed, since the branch they
    // are on is still the branch they should end up on.
    await checkpoint.noteBranch(branch.previous);

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
    const base = this.systemPrompt(options.readOnly) + options.addendum;
    if (!options.readOnly) return base;

    return `${base}\n\n${ANSWER_SHAPE}\n\n${STATE_TAG_INSTRUCTION}`;
  }

  /**
   * The model has stopped asking for tools, so the work is over.
   *
   * A read-only answer has nothing to commit and no branch to tidy; a run has both, and
   * the closing text carries only what the stream could not — where it left you. **Not
   * the narration**, which has already been streamed as text events and printed every
   * answer twice when it was repeated here.
   */
  private async completed(
    branch: AgentBranch,
    task: string,
    narration: string,
    readOnly: boolean
  ): Promise<AgentEvent> {
    if (!readOnly) {
      await this.finish(branch, task, narration);
      // Nothing was kept, so the isolation branch is clutter. Tidied here rather than
      // left for the review wizard, which would otherwise offer five options about an
      // empty branch.
      this.tidied = await branch.discardIfEmpty();
    }

    // **What he actually said, in the conversation.** Narration went to the terminal
    // only, and the chat got the branch note — so a run that ended by asking four
    // questions ("Suggestions shown as a preview, or applied straight away?") put
    // them where nobody was looking, and the panel showed a line about branches.
    // Questions the agent needs answered are the whole point of it asking.
    if (!readOnly) this.log(`agent: finished with ${narration.trim() ? 'a message' : 'nothing to say'}`);

    // **Kept apart, because folding them together hid a silent run.** The closing note
    // is about branches — "your own work on `master` is untouched" — and joining it to
    // the narration made an empty narration look like a summary to the caller, which
    // has an honest line ready for exactly that case and never got to use it. Found
    // live: nine steps, no files, nothing said, and the chat showed a note about
    // branches followed by an aside about the hard part being over.
    return {
      kind: 'done',
      text: readOnly ? '' : narration.trim(),
      closing: readOnly ? undefined : this.closingNote(branch) || undefined,
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
        text: `The coding model isn't configured — ${provider.label} has no key. The bowtie by the prompt sorts that out.`,
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

  /** Leaving cleanly: the branch is tidied, because stopping is not a reason to litter. */
  private async stopped(branch: AgentBranch): Promise<AgentEvent> {
    this.tidied = await branch.discardIfEmpty();
    return { kind: 'done', text: 'Stopped.', files: [...this.touched] };
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

      this.steps++;
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
        step: this.steps,
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
        const approved = await this.approveStep(step);
        if (!approved) {
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

  private async *loop(
    task: string,
    signal: AbortSignal,
    options: { readOnly: boolean; addendum: string }
  ): AsyncGenerator<AgentEvent> {
    const role = options.readOnly ? 'chat' : 'agent';

    const refusal = await this.refuseToStart(role, signal);
    if (refusal) {
      yield this.record(refusal);
      return;
    }

    // Isolation and undo are established *before* the model is asked for anything, so
    // there is no window in which an edit could land unprotected. Neither is set up for
    // a read-only answer: there is nothing to undo and nothing to isolate.
    const checkpoint = new Checkpoint(this.context, this.root, this.log);
    const branch = new AgentBranch(this.log, this.context.workspaceState);
    // Held so the caller can ask afterwards where the work ended up — the run is over
    // by the time "shall I fold this back in?" is worth asking.
    this.lastBranch = branch;

    if (!options.readOnly) yield* this.protect(checkpoint, branch, task);

    const messages: ModelMessage[] = [{ role: 'user', content: task }];

    // A question that needs a dozen tool calls has become a task; capping lower keeps
    // an answer from quietly costing what a run costs.
    const cap = options.readOnly ? Math.min(this.maxSteps, 10) : this.maxSteps;

    while (this.steps < cap) {
      if (signal.aborted) {
        yield this.record(await this.stopped(branch));
        return;
      }

      const calls: ToolCall[] = [];
      let narration = '';

      try {
        for await (const event of this.models.streamWithTools(
          {
            system: this.systemFor(options),
            messages,
            signal,
            tools: options.readOnly ? readOnlyTools() : undefined,
          },
          role
        )) {
          if (event.type === 'text') {
            narration += event.text;
            yield { kind: 'text', text: event.text };
          }
          if (event.type === 'toolCall') calls.push(event.call);
        }
      } catch (error) {
        if (signal.aborted) {
          yield this.record(await this.stopped(branch));
          return;
        }
        yield this.record({ kind: 'error', text: `The model gave up: ${String(error)}` });
        return;
      }

      // No tool calls means the model considers the task finished.
      if (calls.length === 0) {
        // **The expression marker is for the face, never for the reader.** This prompt
        // asks for a `[[state]]` tag and the streaming reply path consumes one — but the
        // closing narration leaves through a `done` event, which that path forwards
        // untouched on the rule that tool lines are ours rather than the model's. This
        // one is the model's, so it arrived on screen with `[[talking]]` still on the
        // front of it. Found live, 20 Aug, and it makes a liar of §7's checklist item
        // saying the tag never appears in reply text — true of one path, not both.
        narration = stripTags(narration).trimStart();
        // **Why it stopped, in the log.** A run that ended after two reads with an
        // empty summary left nothing to diagnose from — found live, and the closing
        // line then invented a conclusion to fill the silence. Narration is what the
        // model said for itself before deciding it was done.
        this.log(
          `agent: model stopped after ${this.steps} step(s), ${this.touched.size} file(s) touched — said: ${JSON.stringify(narration.trim() || '(nothing)')}`
        );
        yield this.record(await this.completed(branch, task, narration, options.readOnly));
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

    try {
      // Snapshot before the change, not after — the whole point of undo.
      if (mutates(name) && typeof args.path === 'string') {
        await checkpoint.capture(await resolveInWorkspace(this.root, args.path));
      }

      const content = await this.invoke(name, args, signal);

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

    const approved = await vscode.window.showWarningMessage(
      explainGate(command, verdict, Boolean(escape)),
      { modal: true },
      ...(escape ? [label, escape] : [label])
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
    const approved = await vscode.window.showWarningMessage(
      strong
        ? `${requestedPath} looks like ${verdict.what}. Reading it hands the actual key to the model.`
        : `${requestedPath} looks like ${verdict.what}. Reading it may hand a live credential to the model.`,
      {
        modal: true,
        detail: `Worst case: ${verdict.worstCase}.${strong ? ' Only approve this if you are certain.' : ''}`,
      },
      strong ? 'Read it anyway' : 'Read it'
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
      if (answer === 'refused') {
        return `The user declined that command. Don't retry it — find another way, or ask.`;
      }
      if (answer === 'unconfined') {
        escaped = true;
        spawnAs = { file: command, args: [], confined: false };
      }
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

    const result = await runCommand(
      this.root,
      command,
      (chunk) => this.terminal.write(chunk),
      signal,
      spawnAs
    );

    const note = confinementNote(spawnAs.confined, result.exitCode, result.output, allowNetwork);
    if (note) this.log(`sandbox: "${command}" failed on something the confinement denied`);

    return [
      `exit ${result.exitCode ?? 'killed'}${result.timedOut ? ' (timed out)' : ''}`,
      result.output.trim() || '(no output)',
      ...(note ? ['', note] : []),
    ].join('\n');
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

  /** Commits the run's own files onto its own branch, if there was anything to commit. */
  private async finish(branch: AgentBranch, task: string, narration: string): Promise<void> {
    if (this.touched.size === 0 || !branch.current) return;

    // Workspace-relative, deliberately: this is the form the run records and the form
    // the "already modified before we started" check compares against. AgentBranch
    // makes them absolute for git at the last moment.
    const summary = commitSubject(narration, task);

    const hash = await branch.commit(`${summary}\n\nTask: ${task}`, [...this.touched]);
    if (hash) this.ownCommits.push(hash);
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
  const detail = args.path ?? args.command ?? args.pattern ?? args.directory ?? '';

  return detail ? `${call.name}: ${String(detail)}` : call.name;
}

export { agentSystemPrompt };
