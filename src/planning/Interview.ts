import { ModelService } from '../model/ModelService';
import { PlanningIO } from './PlanningIO';
import { opening, phrase } from '../personality/Voice';
import { Answer, InterviewState, knownFacts, nextTopic, openQuestions, readyToDraft, TopicId } from './interviewTopics';
import { namedLanguage } from './conventions';
import { FALLBACK_QUESTION, interviewQuestionPrompt, interviewSystemPrompt, ensureNamesChoice, looksLikeQuestionBack, answerBackPrompt } from './interviewPrompt';
import { NameResult, namePrompt, parseNameResult } from './namePrompt';
import { ideaPrompt, parseIdeaResult } from './ideaPrompt';
import { challengePrompt, parseChallengeResult } from './challengePrompt';
import { synthesizeAnswerPrompt, cleanSynthesizedAnswer, discardsOriginalAnswer } from './synthesizePrompt';
import { withDeadline } from '../model/deadline';
import { collect } from '../model/collect';
import { describeWorkspaceSignals, WorkspaceSignals } from './workspaceSignals';

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
/**
 * One reply from the model, in the interview's voice, against the phrasing deadline.
 *
 * **Eight call sites in this file wrote this out by hand**, nineteen lines each, and
 * the only things that differed were the prompt and the character cap. The caps had
 * drifted to 400, 500, 800 and `topic === 'language' ? 2000 : 400` with no way to see
 * them side by side; passing one is now the whole of the difference between the eight.
 *
 * Partial text survives a timeout, exactly as it did before: `collect` swallows its own
 * abort and returns what arrived, so `withDeadline` resolves rather than firing
 * `onAbort`. Every caller here already treats an empty or unparseable reply as "use the
 * written fallback", which is why none of them needs to know which happened.
 */
function promptModel(models: ModelService, prompt: string, limit: number): Promise<string> {
  return withDeadline(
    PHRASE_TIMEOUT_MS,
    (signal) => collect(models, { system: interviewSystemPrompt(), messages: [{ role: 'user', content: prompt }], signal }, limit),
    () => ''
  );
}

const UNKNOWN_ANSWER = /^(i )?don'?t know( yet)?$|^idk$|^no idea$|^not sure$/i;

/**
 * Everything about *this* interview that is not the machinery for running one.
 *
 * One optional argument rather than three, per §0's 0–2-ideal / 3-max: all three are
 * optional, all three are about the particular sitting rather than about interviewing,
 * and the alternative was a fourth, fifth and sixth positional parameter with two
 * `undefined`s at the call site whenever the middle one did not apply.
 */
export interface InterviewSession {
  /**
   * Saves progress after every answer, so a reload costs nothing.
   *
   * Optional: the command-palette route works without it, and an interview that
   * cannot be saved is still an interview.
   */
  remember?: (state: InterviewState, seed: string) => Promise<void>;

  /** An interview already under way, to carry on rather than start over. */
  resume?: { state: InterviewState; seed: string };

  /**
   * What the workspace already says about itself, read before the interview starts.
   *
   * **Handed in rather than fetched here, and that is the point of the parameter.**
   * Reading a directory needs `vscode`, and importing the module that does it made
   * this entire 879-line file impossible for `node --test` to load — one import, one
   * call site, and every question, pushback and synthesis behind it unreachable by a
   * unit test. `CURRENT_STATE.md`'s sixth recommendation is about exactly this, written
   * after a fix to another such file shipped broken because reading the diff was the
   * only verification available. `PlanningFlow` does the reading now.
   */
  workspace?: WorkspaceSignals;
}

export async function runInterview(
  models: ModelService,
  io: PlanningIO,
  log: (message: string) => void,
  session?: InterviewSession
): Promise<{ state: InterviewState; seed: string } | undefined> {
  const { remember, resume, workspace } = session ?? {};

  if (resume) return continueInterview(models, io, log, resume.state, resume.seed, remember);

  // The first question of the interview, written for the moment rather than
  // rewritten from a template — it sets the tone for everything that follows.
  let seed = await io.askText(
    await opening(
      'You are starting a planning interview. Ask them what they are building — one sentence is plenty, and "I don\'t know" is a perfectly good answer they can give.',
      'What are you building? One sentence is plenty.'
    ),
    await seedHint()
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
  if (workspace) {
    state.workspaceContext = describeWorkspaceSignals(workspace);
    log(`planning: workspace — ${state.workspaceContext}`);
  }

  state.projectName = await resolveProjectName(models, io, seed.trim(), log, namedByIdea);

  return continueInterview(models, io, log, state, seed.trim(), remember);
}

/**
 * The question loop, from wherever the interview currently stands.
 *
 * Split out so resuming is the same code as starting: a resumed interview that took
 * a different path through the questions would drift from a fresh one, and the
 * difference would only show up in the half of the product nobody tests twice.
 */
async function continueInterview(
  models: ModelService,
  io: PlanningIO,
  log: (message: string) => void,
  state: InterviewState,
  seed: string,
  remember?: (state: InterviewState, seed: string) => Promise<void>
): Promise<{ state: InterviewState; seed: string } | undefined> {
  // Whether the "I don't know is fine" note has already been made.
  let unknownIsFine = false;

  for (;;) {
    const topic = nextTopic(state);
    if (!topic || readyToDraft(state)) break;

    // Asked for something already said? Then do not ask. Checked before the question is
    // even composed, since phrasing it costs a model call and the answer is already here.
    if (topic === 'language' && (await settleLanguageAlreadyNamed(state, io, log))) {
      await remember?.(state, seed);
      continue;
    }

    const question = await phraseQuestion(models, topic, state, log);
    log(`planning: "${topic}" asked — ${question}`);

    let answer: Answer;

    if (topic === 'language') {
      const resolved = await askLanguage(models, io, question, state, log);
      // Cancelling (Escape) pauses the interview rather than answering "I don't know"
      // on the user's behalf — same rule as the free-text path below.
      if (!resolved) {
        log(`planning: interview paused at "${topic}"`);
        return { state, seed };
      }
      // The raw shortlist is `Name | advantage | cost` per line — real for a
      // QuickPick, unreadable as "what was asked" in a written plan. A plain
      // recap reads honestly instead of dumping the pipe-delimited format.
      resolved.question = 'Which language should this be built in?';
      answer = resolved;
    } else {
      // **Said once, at the top.** Repeating "or say I don't know" under all six
      // questions is a form telling you its own rules over and over; the point lands
      // the first time and is noise every time after.
      const raw = await io.askText(question, unknownIsFine ? undefined : "\"I don't know yet\" is a perfectly good answer here.");
      unknownIsFine = true;

      // Cancelling the box (Escape) pauses the interview rather than answering "I
      // don't know" on the user's behalf — those are different things, and only one
      // of them should get written into the plan as a recorded unknown.
      if (raw === undefined) {
        log(`planning: interview paused at "${topic}"`);
        return { state, seed };
      }

      // A question asked back (F3) is never an answer, however it parses — answer
      // it, then loop back to the same topic rather than recording the question as
      // "remains open" or pushing back on it as if it were vague.
      if (looksLikeQuestionBack(raw)) {
        log(`planning: "${topic}" — asked back — ${raw}`);
        const reply = await answerQuestionBack(models, topic, raw, state, log);
        await io.say(reply ?? "I don't have a good answer for that one — your call.");
        continue;
      }

      answer = toAnswer(topic, raw);
      answer.question = question;
    }

    answer = await challengeAnswer(models, io, topic, answer, state, log);
    log(`planning: "${topic}" answered — ${answer.text ?? '(recorded as unknown)'}`);
    state.answers.push(answer);
    // Saved after every answer rather than at the end: the end is exactly what a
    // reload prevents you reaching.
    await remember?.(state, seed);
  }

  log(`planning: interview reached "enough to draft" — ${openQuestions(state).length} open question(s)`);
  return { state, seed };
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
    const text = await promptModel(models, challengePrompt(topic, answer.text!, state), 400);

    const result = parseChallengeResult(text);
    if (result.fine) {
      log(`planning: "${topic}" — answer accepted as given`);
      return answer;
    }

    log(`planning: "${topic}" — pushed back — ${result.followUp}`);
    // No placeholder. The main question's hint was reduced to once for being a form
    // reciting its own rules — and this one repeated under *every* follow-up, which
    // is the same defect in the place it is most tiring.
    const raw = await answerIfAskedBack(models, io, topic, result.followUp, state, log);
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
    const text = await promptModel(
      models,
      synthesizeAnswerPrompt(topic, original, followUpQuestion, followUpAnswer),
      500
    );

    const cleaned = cleanSynthesizedAnswer(text);
    if (!cleaned) {
      log(`planning: "${topic}" — synthesis returned nothing, kept the raw combination`);
      return fallback;
    }
    // The user answered. A synthesis that comes back saying the topic is still open has
    // thrown that answer away — see `discardsOriginalAnswer`. Keep the plain combination
    // instead: it reads worse and loses nothing, which is the right trade.
    if (discardsOriginalAnswer(original, cleaned)) {
      log(`planning: "${topic}" — synthesis dropped the original answer, kept the raw combination`);
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
 * Answers a question the user asked back mid-interview (F3), rather than treating
 * it as an answer or silently filing it as "remains open".
 *
 * No model, no answer: there is no honest written fallback for an arbitrary
 * question, so the caller says so plainly instead of inventing one.
 */
async function answerQuestionBack(
  models: ModelService,
  topic: TopicId,
  question: string,
  state: InterviewState,
  log: (message: string) => void
): Promise<string | undefined> {
  if (!(await models.isReady('chat'))) return undefined;

  try {
    const text = await promptModel(models, answerBackPrompt(topic, question, state), 500);
    return text.trim() || undefined;
  } catch (error) {
    log(`planning: "${topic}" — answering a question back failed (${String(error)})`);
    return undefined;
  }
}

/**
 * Asks a follow-up question, answering it first if the reply asks it back (F3)
 * instead of answering it.
 *
 * **One retry, matching §4.9's "challenged once, then honoured" rule** — a second
 * question back is left as a decline rather than answered a second time, the same
 * way a vague follow-up is only challenged once elsewhere in this interview.
 */
async function answerIfAskedBack(
  models: ModelService,
  io: PlanningIO,
  topic: TopicId,
  followUpQuestion: string,
  state: InterviewState,
  log: (message: string) => void
): Promise<string | undefined> {
  const raw = await io.askText(followUpQuestion);
  if (!raw?.trim() || !looksLikeQuestionBack(raw)) return raw;

  log(`planning: "${topic}" — follow-up asked back — ${raw.trim()}`);
  const reply = await answerQuestionBack(models, topic, raw.trim(), state, log);
  await io.say(reply ?? "I don't have a good answer for that one — your call.");
  const retry = await io.askText(followUpQuestion);
  return retry?.trim() && !looksLikeQuestionBack(retry) ? retry : undefined;
}

/**
 * The example under the seed question, written fresh when there is a model.
 *
 * The fixed one — a CLI that renames photos by their EXIF date — is a perfectly
 * good example and was the same example every time, in the one place a new user is
 * deciding what this thing is for. A different plausible project each time says
 * "anything, really" better than any wording of "anything, really" could.
 *
 * **The "I don't know" half is added in code, never generated.** It is the
 * instruction that makes the next question possible, and a rewrite that dropped it
 * would quietly close the door this feature exists to hold open.
 */
async function seedHint(): Promise<string> {
  const written = 'a CLI that renames photos by their EXIF date';
  const example = await opening(
    'Give ONE example of a small project someone might describe in a sentence — the sort of thing that goes under a question as a hint. A concrete thing that does something, under twelve words. No joke, no second sentence, no preamble: just the example itself.',
    written,
    'states'
  );

  // **Length enforced here, not asked for there.** Told "under twelve words" it
  // returned two sentences with a joke in the second — found live. A hint that runs
  // longer than the question it sits under has stopped being a hint.
  const short = example.split(/(?<=[.!?])\s+/)[0].trim().replace(/[.]$/, '');
  return `e.g. ${short.length <= 70 ? short : written}, or "I don't know" for ideas`;
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
    const text = await promptModel(models, ideaPrompt(), 800);

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
    // A working title is not an answer: asked to detect a name, the model finds the one
    // it just invented and the question answers itself.
    const text = await promptModel(models, namePrompt(seed, workingTitle !== undefined), 400);

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
    'states'
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
    if (raw === undefined) return undefined;
    const answer = toAnswer('language', raw);
    if (answer.text) await remarkOnLanguage(io, answer.text, state, log);
    return answer;
  }

  if (picked === YOU_PICK) {
    const { name, reasoning } = await pickLanguageForUser(models, options, state, log);
    await remarkOnLanguage(io, name, state, log, reasoning, true);
    return { topic: 'language', text: name, reasoning };
  }

  await remarkOnLanguage(io, picked, state, log, options.find((option) => option.name === picked)?.cost);
  return { topic: 'language', text: picked };
}

/**
 * Says something about the language that was just chosen.
 *
 * **The second moment in the interview with a real opinion available.** A language
 * choice is a decision with consequences he has watched play out — which is exactly
 * the "be specific about *this* project, using the facts you were handed" condition
 * `character.ts` asks for, and the reason this is written fresh rather than drawn
 * from a bank of jokes about Python.
 *
 * The cost he already named for that option is handed over as the thing to be dry
 * about: it keeps the remark tied to something real rather than to a stereotype
 * about the language, which is where a generic model reply would go.
 */
/**
 * Settles the language question from something the user already said, or leaves it alone.
 *
 * **F11.** `who-and-where` answered *"python script ran locally"* was followed immediately
 * by "which language?" — a shortlist whose own first option read *"already specified for
 * this project — none worth mentioning"*. The information was there; nothing looked.
 *
 * `languageDetected` is the field that already means *known without asking*; it was only
 * ever set from files on disk, which a new project does not have. Reusing it means
 * `nextTopic()` needs no change.
 *
 * **Said, never assumed silently.** The remark goes through the same delegated path F1
 * built, so `ensureNamesChoice` guarantees the language is named out loud — a wrong match
 * is then one sentence to correct, rather than a browser page three questions later.
 */
async function settleLanguageAlreadyNamed(
  state: InterviewState,
  io: PlanningIO,
  log: (message: string) => void
): Promise<boolean> {
  const named = namedLanguage(knownFacts(state));
  if (!named) return false;

  state.languageDetected = named;
  state.answers.push({ topic: 'language', text: named });
  log(`planning: "language" — already named in an earlier answer, not asked again — ${named}`);
  await remarkOnLanguage(io, named, state, log, undefined, true);
  return true;
}

async function remarkOnLanguage(
  io: PlanningIO,
  language: string,
  state: InterviewState,
  log: (message: string) => void,
  cost?: string,
  delegated = false
): Promise<void> {
  const line = await opening(
    [
      `They have chosen ${language} for this project.`,
      `The project: ${state.answers.find((answer) => answer.topic === 'what-it-does')?.text ?? 'not yet described'}.`,
      cost ? `The cost you named for it: ${cost}` : '',
      `Say one dry line about that choice — the trade they have just made, not a stereotype about ${language}.`,
    ]
      .filter(Boolean)
      .join(' '),
    `${language} it is.`,
    'states'
  );
  // A choice made *for* the user has to be said out loud, not alluded to — see
  // `ensureNamesChoice`. One they made themselves needs no announcing.
  const said = delegated ? ensureNamesChoice(line, language) : line;
  log(`planning: language — remarked: ${said}`);
  await io.say(said);
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

    const text = await promptModel(models, prompt, 400);

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
    // Every topic but language is one sentence; language is a 2-4 option shortlist and
    // this cap was cutting it off mid-option before it reached "you pick" — the exact
    // truncation seen live. Give it real headroom instead of none.
    const text = await promptModel(models, interviewQuestionPrompt(topic, state), topic === 'language' ? 2000 : 400);

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
