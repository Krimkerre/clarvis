import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_VALUE_CHARS, PUBLISHED, locality, summarise } from './config';

/**
 * The read that exists so a write does not have to (§6.2, §6.7). Every test
 * below is about the same question: what may leave this machine.
 */

const from = (values: Record<string, unknown>) => summarise((id) => values[id]);

test('the settings a person set are the settings that travel', () => {
  const summary = from({
    'clarvis.chat.provider': 'custom',
    'clarvis.chat.model': 'ravis/clarvis-chat',
    'clarvis.agent.model': 'ravis/clarvis-agent',
    'clarvis.voice.enabled': true,
    'clarvis.bridge.enabled': true,
    'workbench.colorTheme': 'clarvis-nervis',
  });

  assert.equal(summary['chat.model'], 'ravis/clarvis-chat');
  assert.equal(summary['agent.model'], 'ravis/clarvis-agent');
  assert.equal(summary['voice.enabled'], true);
  assert.equal(summary['theme'], 'clarvis-nervis');
});

test('a URL somebody typed does not travel; whether it is local does', () => {
  // §6.4 forbids paths and credentials leaving the machine, and a base URL is
  // where both hide: a query string can carry a token and a hostname can name an
  // internal service. The fact NERVIS wants is whether Clarvis is talking to
  // this machine, and that fact is not the string.
  const local = from({ 'clarvis.chat.baseUrl.custom': 'http://127.0.0.1:8731/v1?key=sk-live-42' });
  const remote = from({ 'clarvis.chat.baseUrl.custom': 'https://models.example.com/v1' });

  assert.equal(local['chat.endpoint'], 'loopback');
  assert.equal(remote['chat.endpoint'], 'remote');
  assert.ok(!JSON.stringify(local).includes('sk-live-42'));
  assert.ok(!JSON.stringify(remote).includes('models.example.com'));
});

test('a path to a secret becomes whether there is one', () => {
  const set = from({ 'clarvis.bridge.enrollmentSecretPath': '/Users/someone/.nervis/enrollment' });
  const unset = from({ 'clarvis.bridge.enrollmentSecretPath': '' });

  assert.equal(set['bridge.enrolment_configured'], true);
  assert.equal(unset['bridge.enrolment_configured'], false);
  assert.ok(!JSON.stringify(set).includes('/Users/'), 'the path itself must not travel');
});

test('nothing outside the allowlist is published, whatever is asked for', () => {
  // The list is the security argument. A setting added to the manifest does not
  // become publishable by existing, which is the difference between an allowlist
  // and a filter somebody has to remember to update.
  const summary = from({
    'clarvis.chat.model': 'a-model',
    'clarvis.secret.apiKey': 'sk-live-4242',
    'clarvis.agent.workspaceRoot': '/Users/someone/code',
    'editor.fontFamily': 'Comic Sans',
  });

  // `bridge.enrolment_configured` is derived rather than read, so it is present
  // and false — "there is no enrolment secret" is a fact about this install,
  // where an absent *string* setting is only an absence.
  assert.deepEqual(Object.keys(summary).sort(), ['bridge.enrolment_configured', 'chat.model']);
  assert.equal(summary['bridge.enrolment_configured'], false);
  assert.ok(!JSON.stringify(summary).includes('sk-live-4242'));
  assert.ok(!JSON.stringify(summary).includes('/Users/'));
});

test('a setting nobody set is absent rather than empty', () => {
  // §6.3's rule about unknown values, applied to configuration: "" and "not set"
  // are different facts and only one of them is true of a fresh install.
  const summary = from({ 'clarvis.chat.model': '   ' });

  assert.ok(!('chat.model' in summary));
});

test('a value cannot be made long enough to be a document', () => {
  const summary = from({ 'clarvis.chat.model': 'm'.repeat(400) });

  assert.equal(String(summary['chat.model']).length, MAX_VALUE_CHARS);
});

test('the summary is primitives, so nothing structured can ride out in it', () => {
  const summary = from({
    'clarvis.chat.model': { toString: () => 'not-a-string' },
    'clarvis.voice.enabled': true,
  });

  for (const value of Object.values(summary)) {
    assert.ok(['string', 'boolean'].includes(typeof value));
  }
  assert.ok(!('chat.model' in summary), 'an object is not a model name');
});

test('an unparseable endpoint is reported as unreadable, not quoted', () => {
  assert.equal(locality('not a url at all'), 'unreadable');
  assert.equal(locality(''), undefined);
});

test('every published field names a setting that starts with a known prefix', () => {
  // A guard against the list growing a field whose source nobody can find, and
  // against publishing a setting belonging to another extension entirely.
  for (const { setting } of PUBLISHED) {
    assert.ok(
      setting.startsWith('clarvis.') || setting === 'workbench.colorTheme',
      `${setting} is not Clarvis's to publish`
    );
  }
});
