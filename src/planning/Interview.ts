import * as vscode from 'vscode';
import { ModelService } from '../model/ModelService';
import { Answer, InterviewState, nextTopic, openQuestions, readyToDraft, TopicId } from './interviewTopics';
import { FALLBACK_QUESTION, interviewQuestionPrompt, interviewSystemPrompt } from './interviewPrompt';

/**
 * Runs one project-planning interview (M9a — §4.9), start to "enough to draft".
 *
 * **A minimal, real front end, not the final one.** The eventual shape has questions
 * arriving in the chat panel with an avatar reacting to them; this drives the same
 * state machine and the same prompts through a chained input box instead — the
 * pattern this codebase already uses for `promptForVoiceId` and its siblings. It is
 * genuinely usable end to end today; the panel integration is a later, separate piece
 * of work, not a prerequisite for the interview logic itself being real.
 *
 * **Only the interview.** M9b (analysis), M9c (verdicts) and M9d (writing `plan.md`)
 * are not built yet — this ends by reporting what was gathered and what is still
 * open, not by producing a plan. Each M8 sub-stage shipped alone and was useful
 * alone; this is that same discipline applied to M9.
 */

/** How long the model gets to phrase a question before the written fallback wins. */
const PHRASE_TIMEOUT_MS = 6000;

export async function runInterview(
  models: ModelService,
  log: (message: string) => void
): Promise<{ state: InterviewState; seed: string } | undefined> {
  const seed = await vscode.window.showInputBox({
    prompt: 'What are you building? One sentence is plenty.',
    placeHolder: 'e.g. a CLI that renames photos by their EXIF date',
    ignoreFocusOut: true,
  });
  if (!seed?.trim()) return undefined;

  log(`planning: interview started — "${seed.trim()}"`);

  const state: InterviewState = { answers: [{ topic: 'what-it-does', text: seed.trim() }] };

  for (;;) {
    const topic = nextTopic(state);
    if (!topic || readyToDraft(state)) break;

    const question = await phraseQuestion(models, topic, state, log);
    log(`planning: "${topic}" asked — ${question}`);

    const raw = await vscode.window.showInputBox({
      prompt: question,
      placeHolder: "Type your answer, or \"I don't know yet\" — that's a fine answer here.",
      ignoreFocusOut: true,
    });

    // Cancelling the box (Escape) pauses the interview rather than answering "I don't
    // know" on the user's behalf — those are different things, and only one of them
    // should get written into the plan as a recorded unknown.
    if (raw === undefined) {
      log(`planning: interview paused at "${topic}"`);
      return { state, seed: seed.trim() };
    }

    const answer = toAnswer(topic, raw);
    log(`planning: "${topic}" answered — ${answer.text ?? '(recorded as unknown)'}`);
    state.answers.push(answer);
  }

  log(`planning: interview reached "enough to draft" — ${openQuestions(state).length} open question(s)`);
  return { state, seed: seed.trim() };
}

/** Whatever was typed, as a settled answer or a recorded unknown. */
function toAnswer(topic: TopicId, raw: string): Answer {
  const text = raw.trim();
  const unknown = /^(i )?don'?t know( yet)?$|^idk$|^no idea$|^not sure$/i.test(text);
  return { topic, text: unknown || !text ? undefined : text };
}

async function phraseQuestion(
  models: ModelService,
  topic: TopicId,
  state: InterviewState,
  log: (message: string) => void
): Promise<string> {
  // **Every path here is distinguishable in the log.** The briefing spent several
  // rounds today logging "from the bank" for three different reasons before anyone
  // could tell which one had actually happened; this does not get to make the same
  // mistake on its first day.
  if (!(await models.isReady('chat'))) {
    log(`planning: "${topic}" — no model configured, used the written question`);
    return FALLBACK_QUESTION[topic];
  }

  try {
    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream(
        { system: interviewSystemPrompt(), messages: [{ role: 'user', content: interviewQuestionPrompt(topic, state) }] },
        'chat'
      )) {
        text += fragment;
        if (text.length > 400) break;
      }
    })();

    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, PHRASE_TIMEOUT_MS))]);

    const phrased = text.trim().split('\n')[0];
    if (!phrased) {
      log(`planning: "${topic}" — model returned nothing, used the written question`);
      return FALLBACK_QUESTION[topic];
    }

    log(`planning: "${topic}" — phrased by the model`);
    return phrased;
  } catch (error) {
    log(`planning: "${topic}" — phrasing failed (${String(error)}), used the written question`);
    return FALLBACK_QUESTION[topic];
  }
}
