import assert from 'node:assert/strict';
import test from 'node:test';

import { WebviewSpeech } from './WebviewSpeech';
import type { ButlerViewProvider } from '../panels/ButlerViewProvider';

/**
 * A panel that records what was posted and lets a test decide when the webview
 * "answers". The real one is a `vscode` object; only two members are used here,
 * which is the point of the extraction.
 */
function fakePanel() {
  const posted: Record<string, unknown>[] = [];
  let finish: (event: { id: string; error?: string }) => void = () => {};
  const panel = {
    post: (message: unknown) => posted.push(message as Record<string, unknown>),
    onDidFinishSpeech: (listener: (event: { id: string; error?: string }) => void) => {
      finish = listener;
      return { dispose: () => {} };
    },
  } as unknown as ButlerViewProvider;
  return { panel, posted, finish: (event: { id: string; error?: string }) => finish(event) };
}

test('resolves when the webview reports that id finished', async () => {
  const { panel, posted, finish } = fakePanel();
  const speech = new WebviewSpeech(panel);

  const spoken = speech.request((id) => ({ type: 'speak-audio', id, dataUri: 'data:,' }));
  assert.equal(posted.length, 1);

  finish({ id: posted[0].id as string });
  await spoken;
});

test('rejects when the webview reports an error for that id', async () => {
  const { panel, posted, finish } = fakePanel();
  const speech = new WebviewSpeech(panel);

  const spoken = speech.request((id) => ({ type: 'speak-system', id, text: 'hello' }));
  finish({ id: posted[0].id as string, error: 'audio element error' });

  await assert.rejects(spoken, /audio element error/);
});

test('a report for a different id is ignored rather than resolving the wrong utterance', async () => {
  // Two utterances can be in flight, and the webview answers by id. Resolving on
  // any report would let a finished one release a still-speaking one, which is
  // the same stuck-state class of bug the timeout below guards.
  const { panel, posted, finish } = fakePanel();
  const speech = new WebviewSpeech(panel, 50);

  const first = speech.request((id) => ({ type: 'speak-system', id, text: 'one' }));
  const second = speech.request((id) => ({ type: 'speak-system', id, text: 'two' }));

  finish({ id: posted[1].id as string });
  await second;

  await assert.rejects(first, /timed out/);
});

test('gives up rather than leaving the avatar speaking forever', async () => {
  // A voice that never reports back is indistinguishable from one still
  // talking. Without this the failure is not silence — it is a UI that believes
  // it is mid-sentence for the rest of the session.
  const { panel } = fakePanel();
  const speech = new WebviewSpeech(panel, 20);

  await assert.rejects(
    speech.request((id) => ({ type: 'speak-audio', id, dataUri: 'data:,' })),
    /timed out/
  );
});

test('each request carries a fresh id', () => {
  const { panel, posted } = fakePanel();
  const speech = new WebviewSpeech(panel, 20);

  void speech.request((id) => ({ type: 'speak-system', id, text: 'a' })).catch(() => {});
  void speech.request((id) => ({ type: 'speak-system', id, text: 'b' })).catch(() => {});

  assert.notEqual(posted[0].id, posted[1].id);
});
