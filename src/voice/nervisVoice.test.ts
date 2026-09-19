import test from 'node:test';
import assert from 'node:assert/strict';
import { NervisLink, nervisProfile, renderThroughNervis } from './nervisVoice';

/** Clarvis's voice from NERVIS: the questions asked, and what each answer makes Clarvis do. */

const LINK: NervisLink = { url: 'http://127.0.0.1:8790/', instanceId: 'window 1', token: 'tok-issued' };
const RICK = { voice_id: 'd2e75a3e3fd6419893057c02a375a113', engine: 's2.1-pro', name: 'Rick Sanchez' };

function answering(status: number, body: unknown, seen: Request[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(String(input), init));
    if (body instanceof Uint8Array) return new Response(body, { status });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const failing = (async () => {
  throw new TypeError('fetch failed');
}) as unknown as typeof fetch;

test("the voice is asked for with the window's own token, at the window's own address", async () => {
  const seen: Request[] = [];
  const profile = await nervisProfile(LINK, answering(200, { profile: RICK, can_speak: true }, seen));

  assert.deepEqual(profile, RICK);
  assert.equal(seen[0].url, 'http://127.0.0.1:8790/api/v1/registry/instances/clarvis/window%201/voice');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer tok-issued');
});

test('no voice is used unless NERVIS can actually speak it', async () => {
  assert.equal(await nervisProfile(LINK, answering(200, { profile: RICK, can_speak: false })), undefined);
  assert.equal(await nervisProfile(LINK, answering(200, { profile: null, can_speak: true })), undefined);
  assert.equal(await nervisProfile(LINK, answering(401, { error: 'no' })), undefined);
  assert.equal(await nervisProfile(LINK, failing), undefined);
});

test('a rendered line comes back as audio, sent as the text alone', async () => {
  const seen: Request[] = [];
  const mp3 = new Uint8Array([73, 68, 51, 4]);
  const rendered = await renderThroughNervis(LINK, 'Build passed.', new AbortController().signal, answering(200, mp3, seen));

  assert.equal(rendered.kind, 'audio');
  assert.deepEqual(rendered.kind === 'audio' ? [...rendered.bytes] : [], [73, 68, 51, 4]);
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(await seen[0].json(), { text: 'Build passed.' });
});

test("what NERVIS can't do, Clarvis's own key may try", async () => {
  const signal = new AbortController().signal;
  for (const [status, body] of [
    [401, {}],
    [404, {}],
    [409, { reason: 'no_credential', detail: 'no Fish Audio key is configured in NERVIS' }],
    [409, { reason: 'no_voice', detail: 'no voice is chosen for Clarvis in NERVIS' }],
  ] as const) {
    assert.equal((await renderThroughNervis(LINK, 'hi', signal, answering(status, body))).kind, 'ownVoice', `${status}`);
  }
  assert.equal((await renderThroughNervis(LINK, 'hi', signal, failing)).kind, 'ownVoice', 'unreachable');
});

test("a privacy or spend refusal, or a timeout, is never retried with Clarvis's own key", async () => {
  const signal = new AbortController().signal;
  for (const reason of ['local_only', 'daily_cap']) {
    const rendered = await renderThroughNervis(LINK, 'hi', signal, answering(409, { reason, detail: reason }));
    assert.equal(rendered.kind, 'systemVoice', reason);
  }
  const timedOut = new AbortController();
  timedOut.abort();
  assert.equal((await renderThroughNervis(LINK, 'hi', timedOut.signal, failing)).kind, 'systemVoice',
    'NERVIS may already have paid; paying again with our key would double it');
});
