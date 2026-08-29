/**
 * Turning what Clarvis did into what §6.4 calls it.
 *
 * A separate file from both `activity.ts` and `events.ts`, because it is the
 * only place that has to know both — and because it is where a payload could
 * leak. §6.4's forbidden list is source, terminal output, prompt and response
 * text, command strings, file contents, raw paths, secrets and approval details;
 * every one of those would arrive here as a string on a payload, so keeping the
 * mapping in one small readable function is the review surface.
 *
 * What is published is what the snapshot already holds, and the snapshot is
 * flat primitives with no field for any of the above.
 */

import type { ActivityChange } from './activity';
import type { EventData, EventName, EventStream } from './events';

/** One transition, as an event name and a payload — or nothing worth publishing. */
export function eventFor(change: ActivityChange): { name: EventName; data: EventData } | undefined {
  const { from, to, snapshot } = change;
  const identity: EventData = snapshot.activity_id ? { activity_id: snapshot.activity_id } : {};

  // A gate opening and a gate closing. §6.7 permits NERVIS to display the fact
  // that one awaits, and `awaiting` is a category — never the question asked.
  if (to === 'waiting_for_approval') {
    return {
      name: 'clarvis.gate.requested',
      data: { ...identity, ...(snapshot.awaiting ? { awaiting: snapshot.awaiting } : {}) },
    };
  }
  if (from === 'waiting_for_approval') {
    // Deliberately not saying which way it went. §6.4 forbids approval details,
    // and whether the user said yes is the most detailed thing about a gate.
    return { name: 'clarvis.gate.resolved', data: identity };
  }

  // A step, published as a transition from `agent_running` to itself.
  if (from === 'agent_running' && to === 'agent_running') {
    const counted = snapshot.steps_taken;
    return {
      name: 'clarvis.agent.step',
      data: { ...identity, ...(counted === undefined ? {} : { steps_taken: counted }) },
    };
  }

  if (to === 'chatting') return { name: 'clarvis.chat.started', data: identity };
  if (to === 'agent_running') return { name: 'clarvis.agent.started', data: identity };

  return endingFor(change, identity);
}

/**
 * The three ways work stops, split out because they share a payload and because
 * together with the beginnings above they put one function past the complexity
 * ceiling — which is the ratchet noticing that this had become two decisions.
 */
function endingFor(
  { from, to, kind, snapshot }: ActivityChange,
  identity: EventData
): { name: EventName; data: EventData } | undefined {
  // `stopping` has no name of its own in §6.4 — the `cancelled` events are what
  // the stream carries, and they belong at the end rather than at the request,
  // because a stop that is still being honoured has not cancelled anything yet.
  // Nor is there a name for work that was never in flight: an `idle` with no
  // `kind` is a `finish()` from a `finally` that ran twice, and publishing it
  // would make a dashboard count a run that did not happen.
  if (to === 'stopping' || kind === undefined) return undefined;
  if (to !== 'failed' && to !== 'idle') return undefined;

  const chat = kind === 'chat';
  const data: EventData = {
    ...identity,
    ...(snapshot.elapsed_ms === undefined ? {} : { elapsed_ms: snapshot.elapsed_ms }),
  };

  // No reason, ever: a failure reason is composed from the thing that failed —
  // a command, a path, a model response — and §6.4 forbids all three.
  if (to === 'failed') {
    return { name: chat ? 'clarvis.chat.failed' : 'clarvis.agent.failed', data };
  }

  // An `idle` reached from `stopping` is the user's stop having landed; reached
  // from anywhere else it is the work finishing on its own.
  if (from === 'stopping') {
    return { name: chat ? 'clarvis.chat.cancelled' : 'clarvis.agent.cancelled', data };
  }
  return { name: chat ? 'clarvis.chat.completed' : 'clarvis.agent.completed', data };
}

/**
 * Attach an activity to a stream, and return the way to detach.
 *
 * The wiring is one line so that the decision about *what* is published stays
 * entirely in `eventFor`, where it can be read in one screen.
 */
export function publishActivity(
  activity: { observe(observer: (change: ActivityChange) => void): () => void },
  events: EventStream
): () => void {
  return activity.observe((change) => {
    const event = eventFor(change);
    if (event) events.emit(event.name, event.data);
  });
}
