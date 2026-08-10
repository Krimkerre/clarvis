import * as vscode from 'vscode';
import * as path from 'path';
import { ModelService } from '../model/ModelService';
import { ModelMessage, ToolCall, ToolResult } from '../model/ModelProvider';
import { isToolName, mutates, validateArgs, readOnlyTools, ToolName } from './toolRegistry';
import { isLookingAround, narrateTool } from './toolNarration';
import { commitSubject } from './commitSubject';
import { phrase } from '../personality/Voice';
import { classifyCommand, explainGate } from './Gate';
import { Checkpoint } from './Checkpoint';
import { AgentBranch } from './AgentBranch';
import { readFile, listFiles, search } from './tools/fileTools';
import { applyEdit, writeFile } from './tools/editTools';
import { AgentTerminal, gitDiff, gitStatus, readDiagnostics, runCommand } from './tools/commandTools';
import { canonicalRelative, resolveInWorkspace } from './tools/workspacePaths';
import { characterWith } from '../personality/character';

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
    private readonly log: (message: string) => void
  ) {}

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
      this.log(`agent [${event.kind}] ${step}${(event.detail ?? event.text).split('\n')[0]}`);
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

  private async *loop(
    task: string,
    signal: AbortSignal,
    options: { readOnly: boolean; addendum: string }
  ): AsyncGenerator<AgentEvent> {
    if (!this.root) {
      yield this.record({
        kind: 'error',
        text: await phrase('report', 'There is no folder open, so there is nothing to work on.'),
      });
      return;
    }

    const role = options.readOnly ? 'chat' : 'agent';
    const provider = this.models.spec(role);

    if (!(await this.models.isReady(role))) {
      yield this.record({
        kind: 'error',
        text: `The coding model isn't configured — ${provider.label} has no key. The bowtie by the prompt sorts that out.`,
      });
      return;
    }

    // Isolation and undo are established *before* the model is asked for anything, so
    // there is no window in which an edit could land unprotected. Neither is set up for
    // a read-only answer: there is nothing to undo and nothing to isolate.
    const checkpoint = new Checkpoint(this.context, this.root, this.log);
    const branch = new AgentBranch(this.log, this.context.workspaceState);

    if (!options.readOnly) {
      await checkpoint.begin(task);
      const isolation = await branch.begin(task);

      // **Not announced at all when it works.** The isolation branch is machinery:
      // the user asked for a change, not for a report on how it is being kept safe,
      // and the closing line already says their own work is untouched. Saying it
      // twice — once with a generated branch name nobody needs to read — is the
      // narration this was supposed to remove.
      //
      // A *failure* to isolate is different, and is said, because it changes what
      // undo means.
      if (!isolation.isolated) {
        yield this.record({
          kind: 'text',
          text: `${isolation.advice ?? "I couldn't work on a copy this time."} I've snapshotted your files, so the run can still be undone.`,
        });
      }
    }

    const messages: ModelMessage[] = [{ role: 'user', content: task }];

    // A question that needs a dozen tool calls has become a task; capping lower keeps
    // an answer from quietly costing what a run costs.
    const cap = options.readOnly ? Math.min(this.maxSteps, 10) : this.maxSteps;

    while (this.steps < cap) {
      if (signal.aborted) {
        yield this.record({
          kind: 'done',
          text: await phrase('report', 'Stopped.'),
          files: [...this.touched],
        });
        return;
      }

      const calls: ToolCall[] = [];
      let narration = '';

      try {
        for await (const event of this.models.streamWithTools(
          {
            system: this.systemPrompt(options.readOnly) + options.addendum,
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
          yield this.record({ kind: 'done', text: 'Stopped.', files: [...this.touched] });
          return;
        }
        yield this.record({ kind: 'error', text: `The model gave up: ${String(error)}` });
        return;
      }

      // No tool calls means the model considers the task finished.
      if (calls.length === 0) {
        if (!options.readOnly) {
          await this.finish(branch, task, narration);
          // Nothing was kept, so the isolation branch is clutter. Tidied here rather
          // than left for the review wizard, which would otherwise offer five options
          // about an empty branch.
          this.tidied = await branch.discardIfEmpty();
        }
        // **Not the narration.** It has already been streamed as `text` events, and
        // repeating it here printed every answer twice. The closing event carries only
        // what the stream could not: where the run left you.
        yield this.record({
          kind: 'done',
          text: options.readOnly ? '' : this.closingNote(branch),
          files: [...this.touched],
        });
        return;
      }

      messages.push({ role: 'assistant', content: narration, toolCalls: calls });
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
          step: this.steps,
        });

        const result = await this.dispatch(call, checkpoint, signal);
        results.push(result);

        if (result.isError) yield this.record({ kind: 'gate', text: result.content });
      }

      messages.push({ role: 'user', content: '', toolResults: results });
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
    if (name === 'readFile') {
      const result = await readFile(this.root, args.path);
      return result.truncated ? `${result.text}\n\n[truncated at 512KB]` : result.text;
    }

    if (name === 'listFiles') {
      const files = await listFiles(this.root, {
        directory: args.directory,
        recursive: args.recursive !== false,
      });
      return files.join('\n') || '(no files)';
    }

    if (name === 'search') {
      const hits = await search(this.root, new RegExp(args.pattern), { directory: args.directory });
      return hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`).join('\n') || '(no matches)';
    }

    if (name === 'applyEdit') {
      const outcome = await applyEdit(this.root, args.path, args.find, args.replace);
      return `Edited ${outcome.file}, ${outcome.changedLines} line(s) changed.`;
    }

    if (name === 'writeFile') {
      const outcome = await writeFile(this.root, args.path, args.contents);
      return `${outcome.created ? 'Created' : 'Rewrote'} ${outcome.file}.`;
    }

    if (name === 'runCommand') return this.runGated(args.command, signal);

    if (name === 'readDiagnostics') {
      const problems = readDiagnostics(this.root, args.file);
      return problems.join('\n') || '(no problems reported)';
    }

    if (name === 'gitStatus') return gitStatus();
    if (name === 'gitDiff') return (await gitDiff(args.staged === true)) || '(no changes)';

    return 'Nothing happened.';
  }

  /**
   * Runs a command, asking first when the deny-list says so.
   *
   * The gate is checked **here**, not in the prompt: the model is never told "you may
   * run this if the user agrees", it simply cannot proceed without an approval this
   * code obtained. A refusal comes back as an ordinary tool result so the model can
   * pick a different approach rather than stalling.
   */
  private async runGated(command: string, signal: AbortSignal): Promise<string> {
    const verdict = classifyCommand(command);

    if (verdict) {
      const approved = await vscode.window.showWarningMessage(
        explainGate(command, verdict),
        { modal: true },
        'Run it'
      );

      if (approved !== 'Run it') {
        this.log(`gate: refused "${command}" (${verdict.category})`);
        return `The user declined that command. Don't retry it — find another way, or ask.`;
      }
      this.log(`gate: approved "${command}" (${verdict.category})`);
    }

    this.terminal.announce(command);
    const result = await runCommand(this.root, command, (chunk) => this.terminal.write(chunk), signal);

    return [
      `exit ${result.exitCode ?? 'killed'}${result.timedOut ? ' (timed out)' : ''}`,
      result.output.trim() || '(no output)',
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
    return `\n\nYour own work on \`${branch.previous}\` is untouched — my changes are on a temp branch.`;
  }

  /** Commits the run's own files onto its own branch, if there was anything to commit. */
  private async finish(branch: AgentBranch, task: string, narration: string): Promise<void> {
    if (this.touched.size === 0 || !branch.current) return;

    const files = [...this.touched].map((file) => path.join(this.root!, file));
    const summary = commitSubject(narration, task);

    const hash = await branch.commit(`${summary}\n\nTask: ${task}`, files);
    if (hash) this.ownCommits.push(hash);
  }

  /** What this run committed and touched, for the review wizard. */
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
    // Note what is *absent* from both: any instruction about tone. That comes from
    // character() and nowhere else, because the last version repeated "be terse and dry"
    // here and that one clause outweighed everything the character was supposed to be.
    if (readOnly) {
      return characterWith(
        'You can read the project — files, listings, search, diagnostics, git status and diffs — but you cannot change anything.',
        'Look before you answer: read the file rather than guessing at what it probably contains.',
        'If a question needs a change made, say so plainly and stop; the user asks for work in their own words.',
        // This path answers questions, and an answer here is *spoken*. The first
        // reply after the character landed ran to twenty-two seconds of audio —
        // correct, in voice, and far too long to listen to.
        'Answer in a few sentences. Length is the failure mode: if the answer is running long you have started explaining rather than answering.'
      );
    }

    return characterWith(
      'Work in small steps. Read before you edit. Verify with tests or diagnostics when you can.',
      'You can only touch files inside the workspace; anything outside it is refused.',
      'Destructive, outward-facing and install commands stop and ask the user — expect that, and do not try to work around it.',
      'applyEdit needs text that appears exactly once. Include surrounding lines to make it unique.',
      'When the task is done, stop calling tools and say what you changed — one line, in your own voice, not a changelog.',
      'Never pretend something worked when the tool said otherwise.'
    );
  }
}

/** One readable line per tool call, for the panel. */
function describe(call: ToolCall): string {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const detail = args.path ?? args.command ?? args.pattern ?? args.directory ?? '';

  return detail ? `${call.name}: ${String(detail)}` : call.name;
}
