import * as vscode from 'vscode';
import { AvatarController } from '../AvatarController';
import { ModelService } from '../model/ModelService';
import { AgentRunner } from '../agent/AgentRunner';
import { AgentTerminal, runCommand } from '../agent/tools/commandTools';
import { mergeRunBack, reviewRun } from '../agent/reviewWizard';
import { detectTestCommand } from '../agent/testCommand';
import { Busy } from './Busy';

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
    private readonly log: (message: string) => void
  ) {}

  /**
   * The writer for the opening line, once a model exists.
   *
   * Set after construction because the model layer is wired later — and kept optional
   * rather than making the whole session optional, which pushed `?.` into every caller
   * and cost the routing method three branches for nothing.
   */
  private live: { acknowledge(task: string): Promise<string | undefined> } | undefined;

  setLiveLines(live: { acknowledge(task: string): Promise<string | undefined> }): void {
    this.live = live;
  }

  /**
   * Hands a task to the agent, streaming its steps into the transcript.
   *
   * The route is **announced before anything starts**, because a misrouted question
   * would otherwise begin editing files with no warning — and the announcement is what
   * makes Stop a real option rather than a theoretical one.
   */
  async run(task: string, because: string): Promise<void> {
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
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      this.models,
      this.terminal,
      this.log
    );


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

    try {
      for await (const event of runner.run(task, controller.signal)) {
        if (!event.text) continue;

        // Everything, verbatim, in the place that is meant to be read line by line.
        this.terminal.write(
          event.kind === 'tool' ? `\r\n· ${event.detail ?? event.text}\r\n` : event.text
        );
      }
    } finally {
      this.busy.finish();
      this.avatar.setState('neutral', 'agent');
      holdingFace();
    }

    await vscode.commands.executeCommand('clarvis.checkBranchFlow');

    const { commits, files } = runner.result;
    if (files.length > 0) await this.offerReview(commits, files);
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
