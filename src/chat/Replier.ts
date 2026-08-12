import * as vscode from 'vscode';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { AvatarController } from '../AvatarController';
import { VoiceService } from '../voice/VoiceService';
import { ModelService, explain } from '../model/ModelService';
import { AgentRunner } from '../agent/AgentRunner';
import { AgentTerminal } from '../agent/tools/commandTools';
import { characterWith } from '../personality/character';
import { ReplyStateReader, STATE_TAG_INSTRUCTION } from './replyState';
import { Transcript } from './Transcript';
import { Busy } from './Busy';

/**
 * Answering: the two paths a question can take once a model is involved.
 *
 * **Two, because tool support is not universal.** A chat model that can call tools gets
 * to *look* at the project — reading a file to answer a question needs no branch and no
 * commit — while one that cannot still answers, from what Clarvis watched happen rather
 * than from the file. The choice is made per question, not per session, because the
 * user can change models mid-conversation.
 *
 * Both paths share the same three obligations, which is the reason they live together:
 * open a turn in the transcript before streaming into it, take the face from the tag the
 * model opens with, and hand the finished text to the voice exactly once.
 */
export class Replier {
  constructor(
    private readonly panel: ButlerViewProvider,
    private readonly avatar: AvatarController,
    private readonly voice: VoiceService,
    private readonly models: ModelService,
    private readonly terminal: AgentTerminal,
    private readonly transcript: Transcript,
    private readonly busy: Busy,
    private readonly context: vscode.ExtensionContext,
    private readonly say: (text: string, state: 'neutral') => Promise<void>,
    private readonly log: (message: string) => void
  ) {}

  /**
   * What to say when there is nothing to answer with.
   *
   * Two different situations wearing the same shape: a hosted provider with no key, and
   * a local one that is simply not running. Telling someone to add a key when Ollama is
   * merely switched off sends them looking for a problem they do not have, so each says
   * what to do about *its* case.
   */
  private async sayThereIsNoModel(): Promise<void> {
    const spec = this.models.spec('chat');
    this.log(`chat: no local answer, and ${spec.id} is not configured`);

    await this.say(
      spec.needsKey
        ? `That one's beyond what I've watched happen here — I'd need a model for it, and ${spec.label} has no key yet. \`/key\` sorts it, or \`/model\` picks a different provider.`
        : `That's beyond what I've watched here, and ${spec.label} isn't answering on ${'`'}${spec.baseUrl}${'`'}. Is it running?`,
      'neutral'
    );
  }

  async withModel(question: string, addendum = ''): Promise<void> {
    if (!(await this.models.isReady())) {
      await this.sayThereIsNoModel();
      return;
    }

    // With a tool-capable chat model, questions get to *look* at the project rather
    // than guess — reading a file to answer a question needs no branch and no commit.
    if (await this.models.supportsTools('chat')) {
      await this.withTools(question, addendum);
      return;
    }

    // A fresh controller per question: Stop must abort this turn, not every future one.
    const controller = this.busy.start('reply');

    this.avatar.setState('thinking', 'chat');
    const turn = this.transcript.begin('clarvis');
    this.panel.post({ type: 'chat-stream-start' });

    let text = '';
    // The face the model asked for, read off the front of its own reply (M8e3).
    const reader = new ReplyStateReader();

    try {
      for await (const fragment of this.models.stream({
        system: `${this.systemPrompt() + addendum}\n\n${STATE_TAG_INSTRUCTION}`,
        messages: this.transcript.forModel(),
        signal: controller.signal,
      })) {
        const visible = reader.push(fragment);
        if (!visible) continue; // still buffering the opening, deciding on a tag

        // The expression applies at the *start* of the stream, so the face matches the
        // tone while the reply is being read rather than arriving after it.
        if (text === '') this.avatar.setState(reader.state ?? 'talking', 'chat');
        text += visible;
        turn.text = text;
        this.panel.post({ type: 'chat-stream', text: visible });
      }

      const remainder = reader.flush();
      if (remainder) {
        if (text === '') this.avatar.setState(reader.state ?? 'talking', 'chat');
        text += remainder;
        turn.text = text;
        this.panel.post({ type: 'chat-stream', text: remainder });
      }
    } catch (error) {
      // Stopping is not failing: the user asked for silence and gets it.
      if (controller.signal.aborted) {
        this.log('chat: stream aborted by the user');
      } else {
        const { text: friendly, detail } = explain(error);
        this.log(`chat: model failed — ${detail}`);
        text = text ? `${text}\n\n${friendly}` : friendly;
        turn.text = text;
        this.panel.post({ type: 'chat-stream', text: `\n\n${friendly}` });
      }
    } finally {
      this.busy.finish();
      this.panel.post({ type: 'chat-stream-end' });
      this.avatar.setState('neutral', 'chat');
      await this.transcript.persist();
    }

    // Spoken only once complete — speaking fragment by fragment would produce a
    // stutter, and the queue exists to serialise utterances, not syllables.
    if (text) {
      this.transcript.note(text);
      this.voice.say(text, 'chatReply');
    }
  }

  async withTools(question: string, addendum = ''): Promise<void> {
    const controller = this.busy.start('reply');

    const runner = new AgentRunner(
      this.context,
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      this.models,
      this.terminal,
      this.log
    );

    this.avatar.setState('thinking', 'chat');
    this.panel.post({ type: 'chat-stream-start' });

    // What was actually said, for the voice — accumulated from the stream rather than
    // taken from the closing event, which no longer repeats it.
    let spoken = '';
    const reader = new ReplyStateReader();

    // **The transcript gets it too.** This path streamed straight to the webview and
    // never appended a turn, so an answer that used tools lived only in the live panel:
    // move the panel, collapse it, or open the archive, and it was gone. The other reply
    // path had always done this; this one was written later and did not.
    const turn = this.transcript.begin('clarvis');

    try {
      for await (const event of runner.answer(question, controller.signal, addendum)) {
        if (!event.text) continue;

        // Only prose carries the tag. Tool lines are ours, not the model's.
        if (event.kind !== 'text') {
          this.panel.post({ type: 'chat-stream', text: `\n${event.step}. ${event.text}\n` });
          if (event.kind === 'error') spoken += event.text;
          continue;
        }

        const visible = reader.push(event.text);
        if (!visible) continue;

        if (!spoken) this.avatar.setState(reader.state ?? 'talking', 'chat');
        spoken += visible;
        turn.text = spoken;
        this.panel.post({ type: 'chat-stream', text: visible });
      }

      const remainder = reader.flush();
      if (remainder) {
        if (!spoken) this.avatar.setState(reader.state ?? 'talking', 'chat');
        spoken += remainder;
        turn.text = spoken;
        this.panel.post({ type: 'chat-stream', text: remainder });
      }
    } finally {
      this.busy.finish();
      this.panel.post({ type: 'chat-stream-end' });
      this.avatar.setState('neutral', 'chat');
      await this.transcript.persist();
    }

    if (spoken.trim()) {
      this.transcript.note(spoken);
      this.voice.say(spoken, 'chatReply');
    }
  }

  /**
   * The personality block (§2.1), trimmed to what an answering turn needs.
   *
   * The full agent and planning addenda arrive with M8g; sending them now would be
   * instructing the model about tools it does not have.
   */
  private systemPrompt(): string {
    return characterWith(
      'You are looking at their project: you watch builds, tests and errors as they happen.',
      'Answer in a few sentences unless asked for more. Prefer specifics over hedging.'
    );
  }
}
