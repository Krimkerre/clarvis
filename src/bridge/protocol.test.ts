import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES, capabilitiesBody, voiceCapability, wireIdentifier } from './protocol';

/**
 * Stage 9's exit clause says "voice limitations are advertised through
 * capabilities and do not block core support". Nothing advertised voice at all,
 * so that clause could not be satisfied by any amount of testing — a capability
 * that does not exist cannot carry a limitation.
 */

test('voice on a desktop is simply available', () => {
  const voice = voiceCapability(true, undefined);

  assert.equal(voice.state, 'available');
  assert.equal(voice.reason, '');
});

test('voice on a remote host is degraded, not unavailable', () => {
  // The distinction is the point. Speech still happens; it is the conditions
  // that are narrower. A peer reading `unavailable` would conclude Clarvis had
  // gone quiet, which is a different and less alarming thing than what occurs.
  const voice = voiceCapability(true, 'code-server');

  assert.equal(voice.state, 'degraded');
  assert.equal(voice.constraints?.remote, 'code-server');
});

test('the degraded reason is the one that is currently true', () => {
  // **This assertion changed with the behaviour, which is the point of having
  // it.** It read `/machine running the extension host/` while playback was
  // always a subprocess there. Tier 1 now sends audio to the webview on such a
  // host, so that sentence would advertise a defect that no longer exists — and
  // a capability describing yesterday's failure is worse than one saying
  // nothing, because a peer acts on it.
  const voice = voiceCapability(true, 'code-server');

  assert.match(voice.reason, /panel/);
  assert.match(voice.reason, /before the first utterance/);
  // The exact claim that went stale, not the phrase it contained: the new
  // reason mentions the extension host precisely to say playback is *not* there.
  assert.doesNotMatch(voice.reason, /machine running the extension host/);
  assert.doesNotMatch(voice.reason, /sitting at the server/);
  assert.equal(voice.constraints?.plays_on, 'webview');
});

test('a browser workbench degrades even when remoteName says nothing', () => {
  // The case deriving the answer from `remoteName` alone gets wrong: code-server
  // is a browser workbench whatever it reports for the remote name, and voice
  // there plays through the panel like any other web host.
  const voice = voiceCapability(true, undefined, true);

  assert.equal(voice.state, 'degraded');
  assert.equal(voice.constraints?.plays_on, 'webview');
  assert.equal(voice.constraints?.remote, undefined);
});

test('a desktop host with no remote is plainly available', () => {
  assert.equal(voiceCapability(true, undefined).state, 'available');
});

test('voice turned off says so rather than blaming the host', () => {
  assert.equal(voiceCapability(false, 'code-server').state, 'unavailable');
  assert.match(voiceCapability(false, undefined).reason, /turned off in settings/);
});

test('every capability that is not available carries a reason', () => {
  // §4.1: an honest "unavailable, because X" tells a peer when to look again;
  // silence tells it nothing.
  for (const [id, capability] of Object.entries(CAPABILITIES)) {
    if (capability.state !== 'available') {
      assert.ok(capability.reason.length > 10, `${id} is silent about why`);
    }
  }
});

test('a resolved voice capability reaches the published body', () => {
  const body = capabilitiesBody(1, {
    ...CAPABILITIES,
    'clarvis.voice@1': voiceCapability(true, 'ssh-remote'),
  }) as { capabilities: { id: string; state: string; reason: string }[] };

  const voice = body.capabilities.find((c) => c.id === 'clarvis.voice');
  assert.ok(voice, 'voice is missing from the published set');
  assert.equal(voice.state, 'degraded');
});

test('the published set never carries an @major', () => {
  const body = capabilitiesBody(1) as { capabilities: { id: string }[] };

  for (const capability of body.capabilities) {
    assert.doesNotMatch(capability.id, /@/, '§4.1: the @major is never a wire value');
  }
  assert.equal(wireIdentifier('clarvis.voice@1'), 'clarvis.voice');
});

test('there is still no capability that could approve a gate', () => {
  // §6.7, restated as a test because the declaration is hand-written and this is
  // the line somebody would add without reading it.
  for (const id of Object.keys(CAPABILITIES)) {
    assert.doesNotMatch(id, /gate|approve|tool|command|exec/i, id);
  }
});

test('a capability nobody consumes is not advertised as available', () => {
  // §4.1: do not advertise an operation unless that exact operation passes
  // conformance. `clarvis.events@1` is served and correct, and no consumer has
  // ever subscribed — so reconnect, replay and the event families have not been
  // exercised end to end by anything. "Available" would claim a working
  // integration on the strength of one working half.
  assert.equal(CAPABILITIES['clarvis.events@1'].state, 'degraded');
  assert.match(CAPABILITIES['clarvis.events@1'].reason, /nothing subscribes/);
});
