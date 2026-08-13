import * as vscode from 'vscode';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { VoiceService } from '../voice/VoiceService';
import { ModelService } from '../model/ModelService';
import { branchFromRequest, ChatAction, forgetTarget } from './chatCommands';
import { switchBranch } from '../agent/switchBranch';
import { describeGitPlainly } from '../agent/gitStatusPlain';
import { MODES, ChatMode, modeSpec } from './modes';
import { ACTION_QUESTIONS, worthInferring } from './actionIntent';
import { classifyAction } from './intentModel';
import { FAILURE_KEY, parseRecord } from '../briefing/lastFailure';
import type { Pattern } from '../memory/patterns';

/**
 * Doing the things chat can do, as opposed to answering.
 *
 * "Change the voice" wants the picker, not a paragraph about where the setting lives.
 * These are the fourteen things it can open or toggle, plus the two pieces of state the
 * panel displays — which mode Clarvis is in, and which models are configured.
 *
 * Separate from the answering paths because it shares nothing with them: no model, no
 * stream, no transcript beyond a line saying what just happened. It is a dispatcher, and
 * the only interesting thing in it is that **a guess never acts** — an inferred action
 * asks first, and a declined guess falls through to an ordinary answer.
 */
export class ChatActions {
  constructor(
    private readonly panel: ButlerViewProvider,
    private readonly voice: VoiceService,
    private readonly models: ModelService,
    /** Says a line in the transcript, in character, with a face. */
    private readonly say: (text: string, state: 'neutral') => Promise<void>,
    /** Records a line without speaking it — for things that are their own announcement. */
    private readonly note: (text: string) => Promise<void>,
    private readonly log: (message: string) => void,
    private readonly context: vscode.ExtensionContext,
    /** Drops what pattern memory remembers about a job. Separate store, same request. */
    private readonly forgetPattern: (needle: string) => Promise<number>,
    /** What he currently remembers, for when a forget matches nothing. */
    private readonly knownPatterns: () => Pattern[]
  ) {}

  /** What Clarvis is currently allowed to do, from settings. */
  mode(): ChatMode {
    return modeSpec(vscode.workspace.getConfiguration('clarvis').get<string>('chat.mode', 'auto')).id;
  }

  async chooseMode(): Promise<void> {
    const current = this.mode();

    const picked = await vscode.window.showQuickPick(
      MODES.map((mode) => ({
        label: `${mode.id === current ? '$(check) ' : ''}${mode.label}`,
        description: mode.canEdit ? 'can change files' : 'read-only',
        detail: mode.detail,
        id: mode.id,
      })),
      { placeHolder: 'What should I be allowed to do?', matchOnDetail: true }
    );
    if (!picked) return;

    const config = vscode.workspace.getConfiguration('clarvis');
    // Written to the scope that will actually take effect: a workspace value wins over a
    // global one, so writing Global unconditionally looks like it worked and does nothing.
    const scope =
      config.inspect('chat.mode')?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    await config.update('chat.mode', picked.id, scope);
    this.log(`chat: mode set to ${picked.id}`);
    this.postMode();
  }

  postMode(): void {
    const spec = modeSpec(this.mode());
    this.panel.post({
      type: 'mode',
      short: spec.short,
      safe: !spec.canEdit,
      detail: `${spec.label} — ${spec.detail}`,
    });
  }

  /**
   * Which model is answering, for the bowtie's tooltip.
   *
   * The thing people forget and then misjudge cost by, so it lives one hover from the
   * prompt rather than three menus deep.
   */
  postModelInfo(): void {
    const chat = `${this.models.spec('chat').label} · ${this.models.model('chat')}`;
    const coding = this.models.agentIsSeparate()
      ? `${this.models.spec('agent').label} · ${this.models.model('agent')}`
      : 'same as chat';

    this.panel.post({ type: 'model-info', text: `Chat: ${chat}\nCoding: ${coding}\n\nClick to change` });
  }

  /**
   * Offers to do what a model thinks was meant, and does it only if told to.
   *
   * Returns whether the message has been dealt with. `false` covers three outcomes
   * deliberately — nothing inferred, the guess declined, no model available — because
   * all three mean the same thing to the caller: answer normally. A declined suggestion
   * left hanging would be the worst of both, having interrupted *and* not answered.
   */
  async offerInferred(question: string): Promise<ChatAction | undefined> {
    if (!worthInferring(question)) return undefined;

    const guess = await classifyAction(this.models, question, this.log);
    if (!guess) return undefined;

    // Modal, because it interrupts something the user is waiting on and a toast that
    // times out unanswered would leave the question unanswered too.
    const answer = await vscode.window.showInformationMessage(
      ACTION_QUESTIONS[guess],
      { modal: true, detail: 'I may have misread that — say no and I will just answer.' },
      'Yes'
    );

    if (answer !== 'Yes') {
      this.log(`action intent: declined ${guess}, answering instead`);
      return undefined;
    }

    // Planning is handed back to the caller rather than run here — it takes over the
    // whole conversation, which is ChatService's call to make, not this class's.
    if (guess === 'planProject') return guess;

    await this.run(guess, question);
    return guess;
  }

  async run(action: ChatAction, question = ''): Promise<void> {
    const special = this.special(action, question);
    if (special) return special;

    const command = COMMANDS[action];
    if (!command) return;

    await this.say(command.line, 'neutral');
    await vscode.commands.executeCommand(
      command.id,
      command.id === 'workbench.action.openSettings' ? 'clarvis' : undefined
    );
  }

  /**
   * The actions that are not simply "say a line and run a command".
   *
   * Returns a promise when it handled the action, undefined when it did not — which
   * keeps the common path in `run()` a table rather than a chain with five exceptions
   * in front of it.
   */
  private special(action: ChatAction, question: string): Promise<void> | undefined {
    // Handled here rather than by the agent: a checkout is one deterministic command,
    // and routing it through a run would create an isolation branch, switch away from
    // it, and then try to tidy that branch up by switching back — undoing the thing that
    // was asked for.
    if (action === 'explainGit') {
      return describeGitPlainly().then((lines) => this.say(lines.join(' '), 'neutral'));
    }

    if (action === 'switchBranch') {
      return switchBranch(branchFromRequest(question), this.log).then(async (said) => {
        if (said) await this.say(said, 'neutral');
      });
    }

    if (action === 'help') {
      return this.say('The manual, then. Try not to look surprised.', 'neutral').then(() =>
        this.openManual()
      );
    }

    if (action === 'chooseModel') {
      return this.say(
        'Models. Chat and coding can be different ones — cheap for talking, capable for code.',
        'neutral'
      ).then(() => vscode.commands.executeCommand('clarvis.configureModels')).then(() => undefined);
    }

    if (action === 'forgetFailure') return this.forgetFailure(question);

    if (action === 'toggleMute') {
      const muted = !this.voice.isMuted;
      this.voice.setMuted(muted);
      // Noted rather than said: muting and then hearing about it is absurd, and
      // unmuting announces itself by the next thing he says.
      return this.note(muted ? 'Silenced. I remain, in spirit.' : 'Speaking again.');
    }

    return undefined;
  }

  /**
   * Stops him bringing up a job that failed.
   *
   * The record clears itself only when *that same job* succeeds, which is right for a
   * test you mean to fix and wrong for one that fails on purpose — a probe, a known-bad
   * example, a suite someone is deliberately leaving red. Those get mentioned every
   * morning until the fortnight TTL runs out.
   *
   * Deleting the record rather than muting the line: there is nothing to remember, and
   * a suppression list would be a second thing to explain and to forget about.
   */
  private async forgetFailure(question: string): Promise<void> {
    const stored = parseRecord(this.context.workspaceState.get(FAILURE_KEY));

    // **Both stores, independently.** The first version read the record, and returned
    // early when it was empty — so a second "forget" after the record had already gone
    // never reached the pattern memory, and he carried on opening with "seen it 4× this
    // week" while insisting there was no failure on his mind.
    if (stored) await this.context.workspaceState.update(FAILURE_KEY, undefined);

    const needle = forgetTarget(question) ?? stored?.label;
    const dropped = needle ? await this.forgetPattern(needle) : 0;

    this.log(`chat: forget "${needle ?? 'nothing named'}" — record ${stored ? 'cleared' : 'was empty'}, ${dropped} pattern(s)`);

    if (stored || dropped > 0) {
      await this.say(`Forgotten. \`${needle ?? stored?.label}\` is your business now, not mine.`, 'neutral');
      return;
    }

    // Nothing matched. Saying what he *does* remember is more use than "nothing to do":
    // the name he has it under is rarely the name the user typed.
    const known = this.knownPatterns()
      .map((pattern) => pattern.sample.split('\n')[0].slice(0, 40))
      .slice(0, 3);

    await this.say(
      known.length > 0
        ? `Nothing under that name. What I remember: ${known.join('; ')}.`
        : 'There is nothing on my mind to forget. This is as clear as I get.',
      'neutral'
    );
  }

  /**
   * Shows the manual as a rendered Markdown preview.
   *
   * A preview tab rather than a custom webview: it scrolls, searches, prints and closes
   * like every other document in the editor, follows the user's theme, and costs no UI
   * to maintain. Falls back to the raw file if the preview command is unavailable.
   */
  async openManual(): Promise<void> {
    const manual = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'MANUAL.md');

    try {
      await vscode.commands.executeCommand('markdown.showPreview', manual);
    } catch (error) {
      this.log(`chat: markdown preview unavailable (${String(error)}), opening the source`);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manual));
    }
  }
}

/**
 * The actions that are one line and one command.
 *
 * A table, so adding a command is an entry rather than another branch — and so the lines
 * he says can be read together, which is the only way to notice one of them sounding
 * like a different person.
 */
const COMMANDS: Partial<Record<ChatAction, { id: string; line: string }>> = {
  chooseVoice: { id: 'clarvis.chooseVoice', line: 'Voices. Highlight one to hear it.' },
  chooseEngine: { id: 'clarvis.chooseEngine', line: 'Engines — quality against speed and cost.' },
  setKey: {
    id: 'clarvis.manageModelKeys',
    line: 'Keys, one per provider, all kept. Yours go in the keychain, never a settings file.',
  },
  clearKey: { id: 'clarvis.clearFishKey', line: 'Forgetting the key.' },
  testVoice: { id: 'clarvis.testVoice', line: 'Listen.' },
  openCache: { id: 'clarvis.openVoiceCache', line: 'The saved audio. Delete anything in there freely.' },
  clearConversation: { id: 'clarvis.clearConversation', line: 'Clearing this conversation.' },
  showHistory: { id: 'clarvis.showHistory', line: 'Earlier conversations.' },
  openSettings: { id: 'workbench.action.openSettings', line: 'Every setting I have.' },
};
