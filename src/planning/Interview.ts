import { ModelService } from '../model/ModelService';
import { PlanningIO } from './PlanningIO';
import { opening, phrase } from '../personality/Voice';
import { Answer, InterviewState, nextTopic, openQuestions, readyToDraft, TopicId } from './interviewTopics';
import { FALLBACK_QUESTION, interviewQuestionPrompt, interviewSystemPrompt } from './interviewPrompt';
import { NameResult, namePrompt, parseNameResult } from './namePrompt';
import { ideaPrompt, parseIdeaResult } from './ideaPrompt';
import { challengePrompt, parseChallengeResult } from './challengePrompt';
import { synthesizeAnswerPrompt, cleanSynthesizedAnswer } from './synthesizePrompt';
import { researchWorkspace } from './workspaceResearch';
import { describeWorkspaceSignals } from './workspaceSignals';

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

/** Same "I don't know"-family answers the rest of the interview recognises. */
const UNKNOWN_ANSWER = /^(i )?don'?t know( yet)?$|^idk$|^no idea$|^not sure$/i;

export async function runInterview(
  models: ModelService,
  io: PlanningIO,
  log: (message: string) => void
): Promise<{ state: InterviewState; seed: string } | undefined> {
  // The first question of the interview, written for the moment rather than
  // rewritten from a template — it sets the tone for everything that follows.
  let seed = await io.askText(
    await opening(
      'You are starting a planning interview. Ask them what they are building — one sentence is plenty, and "I don\'t know" is a perfectly good answer they can give.',
      'What are you building? One sentence is plenty.'
    ),
    "e.g. a CLI that renames photos by their EXIF date, or \"I don't know\" for ideas"
  );
  if (seed === undefined) return undefined;

  // An idea picked from the list arrives with a working title. It is a candidate,
  // not the answer — found live: choosing "Commit Roulette" produced a name
  // question whose only option was Commit Roulette, which is not a question.
  let namedByIdea: string | undefined;
  if (!seed.trim() || UNKNOWN_ANSWER.test(seed.trim())) {
    const idea = await offerIdeas(models, io, log);
    if (!idea) return undefined;
    seed = idea.seed;
    namedByIdea = idea.name;
  }

  log(`planning: interview started — "${seed.trim()}"`);

  const state: InterviewState = {
    answers: [{ topic: 'what-it-does', text: seed.trim(), question: 'What are you building?' }],
  };

  // Grounds every question that follows in what's actually here, rather than only
  // in what was just typed — an existing package.json or README is worth more than
  // asking from a blank slate.
  const signals = await researchWorkspace();
  if (signals) {
    state.workspaceContext = describeWorkspaceSignals(signals);
    log(`planning: workspace — ${state.workspaceContext}`);
  }

  state.projectName = await resolveProjectName(models, io, seed.trim(), log, namedByIdea);

  for (;;) {
    const topic = nextTopic(state);
    if (!topic || readyToDraft(state)) break;

    const question = await phraseQuestion(models, topic, state, log);
    log(`planning: "${topic}" asked — ${question}`);

    let answer: Answer;

    if (topic === 'language') {
      const resolved = await askLanguage(models, io, question, state, log);
      // Cancelling (Escape) pauses the interview rather than answering "I don't know"
      // on the user's behalf — same rule as the free-text path below.
      if (!resolved) {
        log(`planning: interview paused at "${topic}"`);
        return { state, seed: seed.trim() };
      }
      // The raw shortlist is `Name | advantage | cost` per line — real for a
      // QuickPick, unreadable as "what was asked" in a written plan. A plain
      // recap reads honestly instead of dumping the pipe-delimited format.
      resolved.question = 'Which language should this be built in?';
      answer = resolved;
    } else {
      const raw = await io.askText(question, "Type your answer, or \"I don't know yet\" — that's a fine answer here.");

      // Cancelling the box (Escape) pauses the interview rather than answering "I
      // don't know" on the user's behalf — those are different things, and only one
      // of them should get written into the plan as a recorded unknown.
      if (raw === undefined) {
        log(`planning: interview paused at "${topic}"`);
        return { state, seed: seed.trim() };
      }

      answer = toAnswer(topic, raw);
      answer.question = question;
    }

    answer = await challengeAnswer(models, io, topic, answer, state, log);
    log(`planning: "${topic}" answered — ${answer.text ?? '(recorded as unknown)'}`);
    state.answers.push(answer);
  }

  log(`planning: interview reached "enough to draft" — ${openQuestions(state).length} open question(s)`);
  return { state, seed: seed.trim() };
}

/**
 * Pushes back once on a vague answer, or an answer that hides a risk or a
 * contradiction — never more than once per topic.
 *
 * **An honest "I don't know" is never challenged** — that is already the
 * first-class answer this interview treats it as, not something to talk someone out
 * of. **At most one follow-up** — §4.9's own "challenged once, then honoured" rule,
 * applied to every topic rather than only language: a topic that pushed back
 * repeatedly would be the interrogation this interview has avoided since M9a.
 * Declining the follow-up (Escape, or leaving it blank) keeps the original answer
 * rather than forcing an elaboration nobody wants to give.
 */
async function challengeAnswer(
  models: ModelService,
  io: PlanningIO,
  topic: TopicId,
  answer: Answer,
  state: InterviewState,
  log: (message: string) => void
): Promise<Answer> {
  if (!answer.text) return answer;
  if (!(await models.isReady('chat'))) return answer;

  try {
    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream(
        { system: interviewSystemPrompt(), messages: [{ role: 'user', content: challengePrompt(topic, answer.text!, state) }] },
        'chat'
      )) {
        text += fragment;
        if (text.length > 400) break;
      }
    })();
    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, PHRASE_TIMEOUT_MS))]);

    const result = parseChallengeResult(text);
    if (result.fine) {
      log(`planning: "${topic}" — answer accepted as given`);
      return answer;
    }

    log(`planning: "${topic}" — pushed back — ${result.followUp}`);
    const raw = await io.askText(result.followUp, 'Type your answer, or leave blank to keep what you said');
    if (!raw?.trim()) {
      log(`planning: "${topic}" — follow-up declined, kept original answer`);
      return answer;
    }

    log(`planning: "${topic}" — follow-up answered — ${raw.trim()}`);
    const synthesized = await synthesizeAnswer(models, topic, answer.text!, result.followUp, raw.trim(), log);
    return { ...answer, text: synthesized };
  } catch (error) {
    log(`planning: "${topic}" — challenge failed (${String(error)}), kept original answer`);
    return answer;
  }
}

/**
 * Merges an answer and its follow-up into one coherent statement, in prose.
 *
 * Found live: gluing them together with a "Follow-up — ..." label produced a raw
 * transcript sitting inside `plan.md`, exactly the incoherent copy-paste this exists
 * to avoid. No model, no rewrite: falls back to a plain concatenation, honest if
 * inelegant, rather than losing either answer.
 */
async function synthesizeAnswer(
  models: ModelService,
  topic: TopicId,
  original: string,
  followUpQuestion: string,
  followUpAnswer: string,
  log: (message: string) => void
): Promise<string> {
  const fallback = `${original} ${followUpAnswer}`;
  if (!(await models.isReady('chat'))) return fallback;

  try {
    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream(
        { system: interviewSystemPrompt(), messages: [{ role: 'user', content: synthesizeAnswerPrompt(topic, original, followUpQuestion, followUpAnswer) }] },
        'chat'
      )) {
        text += fragment;
        if (text.length > 500) break;
      }
    })();
    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, PHRASE_TIMEOUT_MS))]);

    const cleaned = cleanSynthesizedAnswer(text);
    if (!cleaned) {
      log(`planning: "${topic}" — synthesis returned nothing, kept the raw combination`);
      return fallback;
    }
    log(`planning: "${topic}" — synthesized — ${cleaned}`);
    return cleaned;
  } catch (error) {
    log(`planning: "${topic}" — synthesis failed (${String(error)}), kept the raw combination`);
    return fallback;
  }
}

/**
 * A few project ideas, for when the seed question comes back "I don't know".
 *
 * Not asked for automatically — only once the user has actually said they don't
 * know, same as everywhere else in this interview "I don't know" is a real, welcome
 * answer rather than something to route around. No model, no ideas: there is no
 * honest written fallback for "make something up that's funny".
 */
async function offerIdeas(
  models: ModelService,
  io: PlanningIO,
  log: (message: string) => void
): Promise<{ seed: string; name?: string } | undefined> {
  if (!(await models.isReady('chat'))) {
    log('planning: seed — no model configured, could not suggest ideas');
    return undefined;
  }

  try {
    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream(
        { system: interviewSystemPrompt(), messages: [{ role: 'user', content: ideaPrompt() }] },
        'chat'
      )) {
        text += fragment;
        if (text.length > 800) break;
      }
    })();
    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, PHRASE_TIMEOUT_MS))]);

    const ideas = parseIdeaResult(text);
    if (ideas.length === 0) {
      log('planning: seed — idea response did not parse');
      return undefined;
    }

    const SOMETHING_ELSE = 'Something else…';
    const picked = await io.askChoice(
      await phrase('ask', "Fine. Here are four. Two of them I am even serious about.", []),
      [
        ...ideas.map((idea) => ({ label: idea.name, detail: idea.description })),
        { label: SOMETHING_ELSE },
      ]
    );
    if (!picked) {
      log('planning: seed — idea picker cancelled');
      return undefined;
    }
    if (picked === SOMETHING_ELSE) {
      const typed = await io.askText(await phrase('ask', 'What are you building? One sentence is plenty.', []));
      // Described by hand rather than picked, so it is not named yet.
      return typed?.trim() ? { seed: typed.trim() } : undefined;
    }

    const idea = ideas.find((candidate) => candidate.name === picked);
    log(`planning: seed — chose idea: ${picked}`);
    return idea ? { seed: `${idea.name}, ${idea.description}`, name: idea.name } : { seed: picked, name: picked };
  } catch (error) {
    log(`planning: seed — idea generation failed (${String(error)})`);
    return undefined;
  }
}

/**
 * Detects a name already in the seed, or offers a shortlist if there isn't one.
 *
 * A missing name isn't blocking — cancelling the picker just leaves it unresolved and
 * the interview carries on, same as "you pick" cancelling would not stall the rest of
 * the interview over a preference nobody has strong feelings about yet.
 */
async function resolveProjectName(
  models: ModelService,
  io: PlanningIO,
  seed: string,
  log: (message: string) => void,
  /** The working title a picked idea came with — offered as one candidate, not the answer. */
  workingTitle?: string
): Promise<string | undefined> {
  if (!(await models.isReady('chat'))) {
    log('planning: name — no model configured, skipped');
    return undefined;
  }

  try {
    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream(
        {
          system: interviewSystemPrompt(),
          // A working title is not an answer: asked to detect a name, the model
          // finds the one it just invented and the question answers itself.
          messages: [{ role: 'user', content: namePrompt(seed, workingTitle !== undefined) }],
        },
        'chat'
      )) {
        text += fragment;
        if (text.length > 400) break;
      }
    })();
    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, PHRASE_TIMEOUT_MS))]);

    const result = parseNameResult(text);
    if ('named' in result && !workingTitle) {
      log(`planning: name — already named in the seed: ${result.named}`);
      return result.named;
    }
    // **Two is the fewest that is a choice.** A picker offering one name is not
    // asking anything — it is announcing a decision while pretending otherwise.
    if (nameCandidates(result, workingTitle).length < 2) {
      log('planning: name — too few suggestions parsed, not worth asking');
      return workingTitle;
    }

    const candidates = nameCandidates(result, workingTitle);
    const SOMETHING_ELSE = 'Something else…';
    const picked = await io.askChoice(
      await phrase('ask', 'It needs a name. These are the ones I could live with.', []),
      [...candidates, { label: SOMETHING_ELSE }]
    );
    if (!picked) {
      log('planning: name — suggestion picker cancelled, left unresolved');
      return undefined;
    }
    if (picked === SOMETHING_ELSE) {
      const typed = await io.askText(await phrase('ask', 'What should it be called?', []));
      log(`planning: name — ${typed ? `set to ${typed.trim()}` : 'left unresolved'}`);
      if (typed?.trim()) await remarkOnName(io, typed.trim(), seed, log);
      return typed?.trim() || undefined;
    }

    log(`planning: name — chose suggestion: ${picked}`);
    await remarkOnName(io, picked, seed, log);
    return picked;
  } catch (error) {
    log(`planning: name — resolution failed (${String(error)}), skipped`);
    return undefined;
  }
}

/**
 * The names worth offering: the working title first, then the alternatives.
 *
 * The title it arrived with leads because it is the one they have already seen —
 * but as one option among the rest, not a decision already taken.
 */
function nameCandidates(
  result: NameResult,
  workingTitle?: string
): { label: string; detail?: string }[] {
  const suggestions = 'suggestions' in result ? result.suggestions : [];
  return [
    ...(workingTitle ? [{ label: workingTitle, detail: 'The name it arrived with. Keep it.' }] : []),
    ...suggestions
      .filter((suggestion) => suggestion.name.toLowerCase() !== workingTitle?.toLowerCase())
      .map((suggestion) => ({ label: suggestion.name, detail: suggestion.reason })),
  ];
}

/**
 * Says the chosen name out loud, with a remark about it.
 *
 * **The one moment in the interview with something to be funny about.** Everywhere
 * else he is asking questions about a project he knows nothing about yet; a name
 * that was just picked is a concrete thing, in front of him, that he has an opinion
 * about — which is the whole condition `character.ts` says a good line needs.
 *
 * Never blocks: an unusable line means the name is simply confirmed and the
 * interview moves on. Nothing here is load-bearing.
 */
async function remarkOnName(
  io: PlanningIO,
  name: string,
  seed: string,
  log: (message: string) => void
): Promise<void> {
  const line = await opening(
    `They have just named their project "${name}". It is: ${seed}. Say the name back to them and make one dry remark about it — about the name itself, or about what it says about the project.`,
    `${name}, then.`,
    false
  );
  log(`planning: name — remarked: ${line}`);
  await io.say(line);
}

/** One parsed `Name | advantage | cost` line from the model's shortlist. */
interface LanguageOption {
  name: string;
  advantage: string;
  cost: string;
}

/** Parses the model's pipe-delimited shortlist. Lines that don't fit the shape are skipped. */
function parseLanguageOptions(text: string): LanguageOption[] {
  return text
    .split('\n')
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts): parts is [string, string, string] => parts.length === 3 && parts.every(Boolean))
    .map(([name, advantage, cost]) => ({ name, advantage, cost }));
}

/**
 * The language step as a QuickPick menu instead of a free-text prompt.
 *
 * Found live: a wall of text in an input box's single-line prompt field is a bad fit
 * for comparing options, regardless of whether the text is complete. "You pick" and
 * "something else" are added by code, not the model, so they always exist even if
 * parsing finds nothing.
 *
 * **"You pick" resolves to an actual language, not the literal words "You pick".**
 * Found live: the answer got recorded as `language: You pick`, which is not a
 * language and directly contradicts §4.9 — "you pick" is supposed to produce a real
 * choice with a one-line reason, not sit in the plan as an unresolved placeholder.
 */
async function askLanguage(
  models: ModelService,
  io: PlanningIO,
  question: string,
  state: InterviewState,
  log: (message: string) => void
): Promise<Answer | undefined> {
  const options = parseLanguageOptions(question);
  if (options.length === 0) {
    log('planning: "language" — shortlist did not parse, fell back to free text');
    const raw = await io.askText(question, "Type your answer, or \"I don't know yet\" — that's a fine answer here.");
    return raw === undefined ? undefined : toAnswer('language', raw);
  }

  const YOU_PICK = 'You pick';
  const SOMETHING_ELSE = 'Something else…';
  const picked = await io.askChoice(
    await phrase('ask', 'Which language, then. Or leave it to me and accept the consequences.', []),
    [
      ...options.map((option) => ({ label: option.name, detail: `+ ${option.advantage}  —  ${option.cost}` })),
      { label: YOU_PICK, detail: "That's a first-class answer, not a fallback for someone who doesn't know." },
      { label: SOMETHING_ELSE },
    ]
  );
  if (!picked) return undefined;

  if (picked === SOMETHING_ELSE) {
    const raw = await io.askText(await phrase('ask', 'What language?', []));
    return raw === undefined ? undefined : toAnswer('language', raw);
  }

  if (picked === YOU_PICK) {
    const { name, reasoning } = await pickLanguageForUser(models, options, state, log);
    return { topic: 'language', text: name, reasoning };
  }

  return { topic: 'language', text: picked };
}

/**
 * Resolves "you pick" into one option plus a one-line reason.
 *
 * Falls back to the first option with an honest, generic reason if no model is
 * configured or the call fails — never a fabricated justification, same rule as
 * everywhere else this project talks about a project it wasn't told about.
 */
async function pickLanguageForUser(
  models: ModelService,
  options: LanguageOption[],
  state: InterviewState,
  log: (message: string) => void
): Promise<{ name: string; reasoning: string }> {
  const fallback = {
    name: options[0].name,
    reasoning: 'left to me to pick, and no model was available to weigh in — took the first of the shortlist.',
  };
  if (!(await models.isReady('chat'))) {
    log('planning: "language" — "you pick" — no model configured, used the first option');
    return fallback;
  }

  try {
    const known = state.answers
      .filter((answer) => answer.text)
      .map((answer) => `${answer.topic}: ${answer.text}`)
      .join('\n');
    const shortlist = options.map((option) => `${option.name} | ${option.advantage} | ${option.cost}`).join('\n');
    const prompt = [
      'They said "you pick" for the language. Choose exactly one from this shortlist and',
      'give one honest sentence why, grounded in what is known below.',
      '',
      `What is known:\n${known}`,
      '',
      `Shortlist:\n${shortlist}`,
      '',
      'Output exactly one line, nothing else: Name | one-sentence reason',
    ].join('\n');

    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream({ system: interviewSystemPrompt(), messages: [{ role: 'user', content: prompt }] }, 'chat')) {
        text += fragment;
        if (text.length > 400) break;
      }
    })();
    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, PHRASE_TIMEOUT_MS))]);

    const [name, ...rest] = text.trim().split('|').map((part) => part.trim());
    const chosen = options.find((option) => option.name.toLowerCase() === name?.toLowerCase());
    if (!chosen || rest.length === 0 || !rest[0]) {
      log('planning: "language" — "you pick" response did not parse, used the first option');
      return fallback;
    }

    log(`planning: "language" — "you pick" resolved to ${chosen.name}`);
    return { name: chosen.name, reasoning: rest[0] };
  } catch (error) {
    log(`planning: "language" — "you pick" failed (${String(error)}), used the first option`);
    return fallback;
  }
}

/** Whatever was typed, as a settled answer or a recorded unknown. */
function toAnswer(topic: TopicId, raw: string): Answer {
  const text = raw.trim();
  return { topic, text: UNKNOWN_ANSWER.test(text) || !text ? undefined : text };
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
        // Every topic but language is one sentence; language is a 2-4 option shortlist
        // and this cap was cutting it off mid-option before it reached "you pick" — the
        // exact truncation seen live. Give it real headroom instead of none.
        if (text.length > (topic === 'language' ? 2000 : 400)) break;
      }
    })();

    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, PHRASE_TIMEOUT_MS))]);

    // Every topic but language is genuinely one sentence, and truncating to the first
    // line has caught a stray blank line from the model harmlessly. Language is not:
    // it is a shortlist of 2-4 options, inherently multi-line, and the same truncation
    // would have silently thrown away every option after the first one.
    const phrased = (topic === 'language' ? text.trim() : text.trim().split('\n')[0]);
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
