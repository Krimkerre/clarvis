/**
 * What Clarvis needs from a model, and nothing more.
 *
 * Deliberately small. M8b only answers questions — the tool loop arrives in M8e, and
 * designing its interface now would mean designing it against a tool layer that does
 * not exist yet (§0: YAGNI). `supportsTools` is here because the *answer* path needs to
 * know whether to offer the agent at all, not because this interface runs tools.
 */

import type { ToolSchema } from '../agent/toolRegistry';

/**
 * A model as offered to the user.
 *
 * `detail` is what makes a list of forty names choosable — context window, price,
 * whatever the provider will tell us. An id alone is not a choice, it is a quiz.
 */
export interface ModelChoice {
  id: string;
  label: string;
  detail: string;
}

/** One turn in a conversation, in the neutral shape both dialects convert from. */
export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Tool calls this assistant turn asked for, when it did. */
  toolCalls?: ToolCall[];
  /** Results being handed back for a previous turn's calls. */
  toolResults?: ToolResult[];
}

/** A model asking for a tool, before anything has checked whether that tool exists. */
export interface ToolCall {
  /** The provider's own id, needed to match a result back to its call. */
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/**
 * A fragment of a streamed reply.
 *
 * Text and tool calls arrive interleaved on the same stream — a model narrates what it
 * is about to do and then asks for it — so they share one channel rather than two,
 * which is also what keeps the ordering intact for the panel.
 */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'stop'; reason: 'end' | 'tools' };

export interface CompletionRequest {
  system: string;
  /**
   * Which tools to offer. Omitted means all of them — the agent path.
   *
   * Typed as the registry's own schema so a caller cannot invent one here: the
   * allow-list is the registry, and this is a *selection* from it.
   */
  tools?: ToolSchema[];
  messages: ModelMessage[];
  model: string;
  /** Abort signal from the caller — `Clarvis: Stop`, or the panel closing. */
  signal?: AbortSignal;
  /**
   * Which operation this request belongs to, for RAVIS to join on (§8's fourth
   * acceptance scenario). One trace spans a chat turn or a whole agent run; one
   * session spans the conversation. Absent means absent: an empty id sends no
   * header at all, because an empty session id is one RAVIS would store and
   * correlate every anonymous request to.
   */
  traceId?: string;
  sessionId?: string;
  /**
   * The `x-request-id` to send. `ModelService` mints one per call so the event it
   * publishes about the request names the id RAVIS recorded; absent, the adapter
   * mints its own.
   */
  requestId?: string;
}

/**
 * A streamed reply.
 *
 * Streaming rather than a single string because a ten-second silent wait reads as a
 * hang, and because the avatar's `thinking` → `talking` transition is meant to track
 * the actual stream rather than a timer (§4.6).
 */
export interface ModelProvider {
  readonly id: string;

  /** Whether this provider is usable right now — key present, endpoint reachable. */
  isAvailable(): Promise<boolean>;

  /** Yields text fragments as they arrive. Throws `ModelError` on failure. */
  stream(request: CompletionRequest): AsyncIterable<string>;

  /**
   * The same stream, with tools offered and tool calls surfaced.
   *
   * Separate from `stream()` rather than an option on it: the answer path must never
   * accidentally offer tools, and a caller that cannot handle a `toolCall` event
   * should be unable to receive one.
   */
  streamWithTools?(request: CompletionRequest): AsyncIterable<StreamEvent>;

  /**
   * Whether this provider *and this model* can call tools.
   *
   * Probed, never assumed (§4.6): a model that chats well can still be useless in a
   * twelve-step tool loop, and local models vary wildly. The result gates whether the
   * agent path is offered — better to say "this model can't do that" than to start a
   * run that flails.
   */
  supportsTools(model: string): Promise<boolean>;

  /**
   * Models this provider offers, for the picker. Empty when it can't be listed.
   *
   * **Fetched live from the provider, never hardcoded.** Model line-ups change far
   * faster than this extension ships, so a baked-in list is stale the week after
   * release — and a user staring at a picker missing the model they are paying for has
   * no way to tell whether it is unsupported or merely unlisted.
   */
  listModels(): Promise<ModelChoice[]>;
}

/**
 * A failure worth showing the user, separated from the raw HTTP detail.
 *
 * §4.6 requires an in-character error rather than a status code dumped into the
 * transcript — but the detail still has to reach the log, or a support conversation
 * becomes guesswork. So both travel together and the caller picks which to show where.
 */
export class ModelError extends Error {
  constructor(
    /** Shown to the user, in Clarvis's voice. */
    readonly friendly: string,
    /** Written to the output channel. Never shown in the transcript. */
    readonly detail: string,
    /** True when retrying could plausibly work — a timeout, a 429, a dropped socket. */
    readonly retryable = false
  ) {
    super(detail);
    this.name = 'ModelError';
  }
}

/**
 * Turns an HTTP failure into something a person can act on.
 *
 * The four cases below are the ones users actually hit, and each has a different fix —
 * collapsing them into "request failed" is what makes an integration feel broken when
 * it is merely unconfigured.
 */
export function describeHttpFailure(status: number, body: string, providerLabel: string): ModelError {
  if (status === 401 || status === 403) {
    return new ModelError(
      `${providerLabel} won't have me — the key is missing, wrong, or out of date.`,
      `auth failed (${status}): ${body.slice(0, 400)}`
    );
  }

  if (status === 429) {
    return new ModelError(
      `${providerLabel} is rate-limiting me. Give it a moment.`,
      `rate limited (429): ${body.slice(0, 400)}`,
      true
    );
  }

  if (status === 404) {
    return new ModelError(
      `${providerLabel} doesn't recognise that model. Pick another with \`/model\`.`,
      `not found (404): ${body.slice(0, 400)}`
    );
  }

  if (status >= 500) {
    return new ModelError(
      `${providerLabel} is having a moment. Not my fault, for once.`,
      `server error (${status}): ${body.slice(0, 400)}`,
      true
    );
  }

  return new ModelError(
    `${providerLabel} refused that request.`,
    `http ${status}: ${body.slice(0, 400)}`
  );
}
