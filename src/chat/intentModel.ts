import { ModelService } from '../model/ModelService';
import { intentPrompt, parseIntent, Route } from './routing';
import { actionPrompt, parseAction } from './actionIntent';
import { ChatAction } from './chatCommands';

/**
 * Asking the model whether a message is a job or a question.
 *
 * The keyword router is written from the verbs someone thought of, and has now been
 * wrong twice in the same direction — `make`/`build`, then `edit`/`change`. A model
 * knows what "swap the port over" means without anyone having listed "swap".
 *
 * Four constraints, all here rather than at the call site:
 *  - **only when the router fell through**, never on a message with a clear signal
 *  - **a short deadline**, because a routing decision is in front of everything else
 *  - **strictly parsed**, so an unexpected reply leaves the deterministic route intact
 *  - **ambiguity still means answering** — the prompt says so, and an unreadable reply
 *    means the same
 */

/** Routing sits in front of the whole reply, so this has to be quick or absent. */
const DEADLINE_MS = 2500;

export async function classifyIntent(
  models: ModelService,
  text: string,
  log: (message: string) => void
): Promise<Route | undefined> {
  if (!(await models.isReady('chat'))) return undefined;

  try {
    const raw = await Promise.race([
      collect(models, intentPrompt(text)),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DEADLINE_MS)),
    ]);

    const route = parseIntent(raw);
    log(`intent: model said ${route ?? 'nothing usable'} for "${text.slice(0, 50)}"`);
    return route;
  } catch (error) {
    log(`intent: classification failed (${String(error)})`);
    return undefined;
  }
}

/**
 * Whether a message was asking for one of the extension's own actions (M8f2).
 *
 * Same shape as the route classifier above and for the same reasons — a deadline,
 * strict parsing, and silence on anything unexpected. What it returns is a *suggestion*:
 * the caller asks the user before doing anything with it.
 */
export async function classifyAction(
  models: ModelService,
  text: string,
  log: (message: string) => void
): Promise<ChatAction | undefined> {
  if (!(await models.isReady('chat'))) return undefined;

  try {
    const raw = await Promise.race([
      collect(models, actionPrompt(text)),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DEADLINE_MS)),
    ]);

    const action = parseAction(raw);
    log(`action intent: model said ${action ?? 'none'} for "${text.slice(0, 50)}"`);
    return action;
  } catch (error) {
    log(`action intent: classification failed (${String(error)})`);
    return undefined;
  }
}

async function collect(models: ModelService, prompt: string): Promise<string> {
  let text = '';

  for await (const fragment of models.stream(
    { system: 'You answer with exactly one word.', messages: [{ role: 'user', content: prompt }] },
    'chat'
  )) {
    text += fragment;
    // One word is expected; anything past this is a reply that will be rejected anyway.
    if (text.length > 40) break;
  }

  return text;
}
