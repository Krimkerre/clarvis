import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitAbsenceReason } from './gitAbsence';

test('an untrusted folder is named as the cause, not the symptom', () => {
  // Observed under code-server 4.135.0: git 2.55.0 on PATH, `vscode.git` shipped
  // in the install, and the extension absent from the host entirely — because
  // the folder opened in Restricted Mode. "No Git extension" sends somebody to
  // install one they already have.
  const reason = gitAbsenceReason(false);

  assert.match(reason, /not trusted/);
  assert.doesNotMatch(reason, /no Git extension/);
});

test('the untrusted line says what trusting would restore', () => {
  // A cause with no next step is only half an improvement.
  assert.match(gitAbsenceReason(false), /trust it/);
});

test('a trusted folder with no Git extension still says so', () => {
  // The original message was not wrong, only incomplete. On a trusted folder it
  // is the accurate one and must survive.
  assert.match(gitAbsenceReason(true), /no Git extension/);
});
