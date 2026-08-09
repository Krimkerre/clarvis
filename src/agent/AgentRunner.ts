import * as vscode from 'vscode';
import * as path from 'path';
import { ModelService } from '../model/ModelService';
import { ModelMessage, ToolCall, ToolResult } from '../model/ModelProvider';
import { isToolName, mutates, validateArgs, ToolName } from './toolRegistry';
import { classifyCommand, explainGate } from './Gate';
import { Checkpoint } from './Checkpoint';
import { AgentBranch } from './AgentBranch';
import { readFile, listFiles, search } from './tools/fileTools';
import { applyEdit, writeFile } from './tools/editTools';
import { AgentTerminal, gitDiff, gitStatus, readDiagnostics, runCommand } from './tools/commandTools';
import { resolveInWorkspace } from './tools/workspacePaths';

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
  text: string;
  /** Files touched so far, for the commit and the summary. */
  files?: string[];
  step?: number;
}

export class AgentRunner {
  private readonly touched = new Set<string>();
  private steps = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly root: string | undefined,
    private readonly models: ModelService,
    private readonly terminal: AgentTerminal,
    private readonly log: (message: string) => void
  ) {}

  private get maxSteps(): number {
    return vscode.workspace.getConfiguration('clarvis').get<number>('agent.maxStepsPerTask', 25);
  }

  /**
   * Runs a task to completion, or until something stops it.
   *
   * An async generator so the caller streams progress without this class knowing about
   * panels or transcripts — the same shape the model stream uses, one layer up.
   */
  async *run(task: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    if (!this.root) {
      yield { kind: 'error', text: 'There is no folder open, so there is nothing to work on.' };
      return;
    }

    const provider = this.models.spec('agent');
    if (!(await this.models.isReady('agent'))) {
      yield {
        kind: 'error',
        text: `The coding model isn't configured — ${provider.label} has no key. The bowtie by the prompt sorts that out.`,
      };
      return;
    }

    // Isolation and undo are established *before* the model is asked for anything, so
    // there is no window in which an edit could land unprotected.
    const checkpoint = new Checkpoint(this.context, this.root, this.log);
    await checkpoint.begin(task);

    const branch = new AgentBranch(this.log);
    const isolation = await branch.begin(task);

    yield {
      kind: 'text',
      text: isolation.isolated
        ? `Working on \`${isolation.branch}\`. Your branch is untouched.`
        : `${isolation.advice ?? "I couldn't isolate this run."} Undo is still available.`,
    };

    const messages: ModelMessage[] = [{ role: 'user', content: task }];

    while (this.steps < this.maxSteps) {
      if (signal.aborted) {
        yield { kind: 'done', text: 'Stopped.', files: [...this.touched] };
        return;
      }

      const calls: ToolCall[] = [];
      let narration = '';

      try {
        for await (const event of this.models.streamWithTools(
          { system: this.systemPrompt(), messages, signal },
          'agent'
        )) {
          if (event.type === 'text') {
            narration += event.text;
            yield { kind: 'text', text: event.text };
          }
          if (event.type === 'toolCall') calls.push(event.call);
        }
      } catch (error) {
        if (signal.aborted) {
          yield { kind: 'done', text: 'Stopped.', files: [...this.touched] };
          return;
        }
        yield { kind: 'error', text: `The model gave up: ${String(error)}` };
        return;
      }

      // No tool calls means the model considers the task finished.
      if (calls.length === 0) {
        await this.finish(branch, task, narration);
        yield { kind: 'done', text: narration.trim() || 'Done.', files: [...this.touched] };
        return;
      }

      messages.push({ role: 'assistant', content: narration, toolCalls: calls });
      const results: ToolResult[] = [];

      for (const call of calls) {
        if (signal.aborted) break;

        this.steps++;
        yield { kind: 'tool', text: describe(call), step: this.steps };

        const result = await this.dispatch(call, checkpoint, signal);
        results.push(result);

        if (result.isError) yield { kind: 'gate', text: result.content };
      }

      messages.push({ role: 'user', content: '', toolResults: results });
    }

    // The cap is a stop-and-ask, not a failure: a long task is not a wrong one, but a
    // loop that never converges must not run up a bill unattended.
    yield {
      kind: 'done',
      text: `I've used ${this.steps} steps without finishing. Say "carry on" if it's going well, or stop me here.`,
      files: [...this.touched],
    };
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
      this.log(`agent: refused unknown tool "${call.name}"`);
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
      if (mutates(name) && typeof args.path === 'string') this.touched.add(args.path);

      return { id: call.id, content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`agent: ${name} failed — ${message}`);
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

  /** Commits the run's own files onto its own branch, if there was anything to commit. */
  private async finish(branch: AgentBranch, task: string, narration: string): Promise<void> {
    if (this.touched.size === 0 || !branch.current) return;

    const files = [...this.touched].map((file) => path.join(this.root!, file));
    const summary = narration.trim().split('\n')[0]?.slice(0, 72) || task.slice(0, 72);

    await branch.commit(`${summary}\n\nTask: ${task}`, files);
  }

  /**
   * The agent's instructions.
   *
   * States the constraints the *code* enforces, so the model's expectations match
   * reality — a model that believes it can reach outside the workspace wastes steps
   * discovering otherwise. It is not where the constraints live.
   */
  private systemPrompt(): string {
    return [
      "You are Clarvis, a butler-like coding agent working inside the user's editor.",
      'Work in small steps. Read before you edit. Verify with tests or diagnostics when you can.',
      'You can only touch files inside the workspace; anything outside it is refused.',
      'Destructive, outward-facing and install commands stop and ask the user — expect that, and do not try to work around it.',
      'applyEdit needs text that appears exactly once. Include surrounding lines to make it unique.',
      'When the task is done, stop calling tools and say briefly what you changed.',
      'Be terse and dry. Never pretend something worked when the tool said otherwise.',
    ].join(' ');
  }
}

/** One readable line per tool call, for the panel. */
function describe(call: ToolCall): string {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const detail = args.path ?? args.command ?? args.pattern ?? args.directory ?? '';

  return detail ? `${call.name}: ${String(detail)}` : call.name;
}
