import { ReplyStateReader } from '../chat/replyState';
import { StreamEvent, ToolCall } from '../model/ModelProvider';

/**
 * One stream event, folded into the running narration and whatever is safe to show.
 *
 * `vscode`-free on purpose, same reason as everywhere else this matters in the project:
 * `AgentRunner.ts` imports `vscode` at module scope, so anything pulled in through it is
 * untestable outside the extension host. This is the actual guarantee — extracting it
 * here is what makes it checkable at all.
 *
 * **Found live, 20 Aug.** Text events used to be yielded straight from the raw stream,
 * with the tag stripped only from a *second* copy built afterwards for the log — by which
 * point every fragment carrying `[[talking]]` was already on screen. This applies the same
 * fix the chat reply path already had, at the point of emission rather than after it:
 * `reader` buffers the head, so a leading `[[state]]` tag never reaches a `text` event in
 * the first place. A tool call is recorded and shows nothing.
 */
export function absorbStreamEvent(
  event: StreamEvent,
  calls: ToolCall[],
  reader: ReplyStateReader,
  narration: string
): { narration: string; visible: string } {
  if (event.type === 'toolCall') {
    calls.push(event.call);
    return { narration, visible: '' };
  }
  if (event.type !== 'text') return { narration, visible: '' };

  return { narration: narration + event.text, visible: reader.push(event.text) };
}
