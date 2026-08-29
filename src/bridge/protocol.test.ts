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
  // The distinction is the point. Speech still happens — out of the wrong
  // machine's speakers. A peer reading `unavailable` would conclude Clarvis had
  // gone quiet, which is a different and less alarming thing than what occurs.
  const voice = voiceCapability(true, 'code-server');

  assert.equal(voice.state, 'degraded');
  assert.match(voice.reason, /machine running the extension host/);
  assert.equal(voice.constraints?.remote, 'code-server');
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
