// Everything that runs inside the Clarvis webview.
//
// A real file rather than a template literal in TypeScript. It lived as one for most of
// M8, and the script was broken twice by a stray backtick inside a comment: the whole
// body was a single `...` string, so one character ended it early and the panel quietly
// stopped responding. Nothing here interpolates from the host — the only thing stamped
// in per render is the CSP nonce, on the tag — so a file costs nothing and removes that
// trap for good.
const vscode = acquireVsCodeApi();

// Chromium blocks audio playback until this document has received a user
// gesture. speechSynthesis is exempt, which is why the system voice works from
// the first second and rendered audio does not. One click anywhere in the panel
// grants it for the rest of the session.
let audioUnlocked = false;
const unlockAudio = () => {
  if (audioUnlocked) return;
  audioUnlocked = true;
  vscode.postMessage({ type: 'audio-unlocked' });
};
window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

// Reports what the audio APIs actually look like in here. M1 probed
// SpeechRecognition (input) and found it blocked, but never checked
// speechSynthesis (output) — different API, no permission, and Tier 0 depends
// entirely on it, so it's worth knowing rather than assuming.
vscode.postMessage({
  type: 'audio-probe',
  speechSynthesis: typeof window.speechSynthesis !== 'undefined',
  audioElement: typeof window.Audio !== 'undefined',
});

const transcript = document.getElementById('clarvis-transcript');
const input = document.getElementById('clarvis-input');
const muteButton = document.getElementById('clarvis-mute');

// Renders one turn. Only inline backtick spans become <code>; everything else is
// inserted as a text node, so a filename or an error message containing markup
// can never become markup. Replies are generated locally today, but this same
// box renders model output in M8b — sanitising it later would be too late.
// The turn currently streaming, and its text so far.
let streaming = null;
let streamed = '';

const addTurn = (speaker, text) => {
  const row = document.createElement('div');
  // The speaker is a class rather than inline styling, so the colours live in
  // one place with the rest of the theme variables.
  row.className = 'clarvis-turn ' + (speaker === 'user' ? 'user' : 'clarvis');

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = speaker === 'user' ? 'You' : 'Clarvis';
  row.appendChild(who);

  renderInto(row, text);

  transcript.appendChild(row);
  transcript.scrollTop = transcript.scrollHeight;
  // Returned so a streamed reply can keep re-rendering the same row.
  return row;
};

// Replaces a turn's body, keeping its speaker label. Text nodes only, plus
// <code> for backtick spans — never innerHTML, because model output lands here.
const renderInto = (row, text) => {
  while (row.childNodes.length > 1) row.removeChild(row.lastChild);

  String(text).split('\\u0060').forEach((part, i) => {
    // Odd indices sat between a pair of backticks.
    if (i % 2 === 1) {
      const code = document.createElement('code');
      code.textContent = part;
      row.appendChild(code);
    } else {
      row.appendChild(document.createTextNode(part));
    }
  });
};

// The choice row currently offered, if any. Removed as soon as one is taken, so
// a stale set of buttons can never answer a later question.
let choiceRow = null;

const clearChoices = () => {
  if (choiceRow) choiceRow.remove();
  choiceRow = null;
};

// Each option is one button carrying its own explanation, rather than a list
// of options above a row of bare labels saying the same thing twice.
const showChoices = (items) => {
  clearChoices();
  if (!items.length) return;

  const row = document.createElement('div');
  // Options with an explanation stack full-width so the text has room; bare
  // labels (Yes / No / Approve) sit side by side, where a stack looks absurd.
  // A long label needs the same full width an explained option does — four fixes
  // phrased as sentences, laid out side by side, are four slivers of text.
  const detailed = items.some((item) => (item && item.detail) || String((item && item.label) || item).length > 28);
  // Two bare labels is a yes-or-no, and those get pushed to opposite ends and made
  // bigger. They arrive mid-conversation, right where you were about to type, and a
  // misclick on one of those is a decision you never made.
  const binary = !detailed && items.length === 2;
  row.className = 'clarvis-choices' + (detailed ? ' stacked' : '') + (binary ? ' binary' : '');

  items.forEach((item) => {
    const label = String((item && item.label) || item);
    const button = document.createElement('button');
    button.className = 'clarvis-choice';

    const name = document.createElement('span');
    name.className = 'label';
    // textContent, never innerHTML: every one of these comes from a model.
    name.textContent = label;
    button.appendChild(name);

    if (item && item.detail) {
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = String(item.detail);
      button.appendChild(detail);
    }

    button.addEventListener('click', () => {
      clearChoices();
      vscode.postMessage({ type: 'ask', text: label });
    });
    row.appendChild(button);
  });

  choiceRow = row;
  transcript.appendChild(row);
  transcript.scrollTop = transcript.scrollHeight;
};

const send = () => {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  // Typing an answer retires the buttons offering the same question.
  clearChoices();
  vscode.postMessage({ type: 'ask', text });
};

// Enter sends, Shift+Enter makes a new line — the convention every chat box
// uses, and getting it backwards is instantly infuriating.
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

muteButton.addEventListener('click', () => vscode.postMessage({ type: 'toggle-mute' }));
// The host asks for confirmation before wiping — a webview button sitting next
// to one people click constantly is a misclick waiting to happen.
document.getElementById('clarvis-clear')
  .addEventListener('click', () => vscode.postMessage({ type: 'clear-chat' }));
document.getElementById('clarvis-history')
  .addEventListener('click', () => vscode.postMessage({ type: 'show-history' }));
document
  .getElementById('clarvis-output')
  .addEventListener('click', () => vscode.postMessage({ type: 'show-output' }));

const modelsButton = document.getElementById('clarvis-models');
modelsButton.addEventListener('click', () => vscode.postMessage({ type: 'models' }));

const modeButton = document.getElementById('clarvis-mode');
modeButton.addEventListener('click', () => vscode.postMessage({ type: 'choose-mode' }));

// One button, by the prompt. A second one up with Mute was tried and removed: two
// controls doing the same thing is a question about which one is which.
const stopButtons = [document.getElementById('clarvis-stop')];
// **Always visible.** Hiding it until something was running meant hunting for a
// control at the moment you least want to hunt — and it was wrong twice about
// when "running" was. It only changes colour now: live when there is something
// to stop, quiet when there is not, and clickable either way.
// **Always visible, greyed when there is nothing to stop.** Hiding it meant hunting
// for a control at the moment you least want to hunt — and it was wrong twice
// about when "running" was, so it was missing during every agent run. Disabled
// rather than merely faint: grey that still accepts a click is a button that
// looks broken.
const showStop = (busy) =>
  stopButtons.forEach((button) => {
    button.dataset.busy = busy ? 'true' : 'false';
    button.disabled = !busy;
  });
stopButtons.forEach((button) =>
  button.addEventListener('click', () => vscode.postMessage({ type: 'stop' }))
);

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'chat-turn') {
    addTurn(msg.speaker, msg.text);
    return;
  }

  // Clickable answers to a question Clarvis just asked. Typing still works —
  // these are a shortcut, never the only way through, since an interview you
  // can only click through is one a keyboard user cannot finish.
  if (msg.type === 'choices') {
    showChoices(msg.items || []);
    return;
  }

  // Where the build has got to. Hidden entirely when nothing is running — an idle
  // progress bar reading 0/0 is furniture.
  if (msg.type === 'progress') {
    var box = document.getElementById('clarvis-progress');
    if (!msg.total) {
      box.setAttribute('data-active', 'false');
      return;
    }
    box.setAttribute('data-active', 'true');
    box.querySelector('.count').textContent = 'Step ' + msg.current + ' of ' + msg.total;
    box.querySelector('.step').textContent = String(msg.label || '');
    box.querySelector('.bar i').style.width = Math.round((msg.current / msg.total) * 100) + '%';
    return;
  }

  if (msg.type === 'choices-clear') {
    clearChoices();
    return;
  }

  // Text handed back for editing — a rewrite starts from what is there, rather
  // than from a blank box next to something you have to copy by hand.
  if (msg.type === 'prefill') {
    input.value = String(msg.text || '');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return;
  }

  // A streamed reply is one turn that grows, not many turns. Appending to the
  // same node keeps inline code spans working across fragment boundaries, which
  // rendering each fragment separately would break.
  // Whether there is something to stop is its own signal, not a side effect of
  // text arriving — an agent run produces no text frames at all.
  if (msg.type === 'busy') {
    showStop(msg.busy);
    return;
  }

  if (msg.type === 'chat-stream-start') {
    streaming = addTurn('clarvis', '');
    streamed = '';
    return;
  }

  if (msg.type === 'chat-stream') {
    // Defensive: if the start frame was missed, adopt this fragment into a new
    // row rather than dropping it. Requiring a live row here once swallowed an
    // entire reply: the text arrived, was spoken aloud, and never appeared in
    // the transcript. (No backticks in this comment - the whole script is a
    // template literal, and one would end it.)
    if (!streaming) {
      streaming = addTurn('clarvis', '');
      streamed = '';
    }

    streamed += msg.text;
    renderInto(streaming, streamed);
    transcript.scrollTop = transcript.scrollHeight;
    return;
  }

  if (msg.type === 'chat-stream-end') {
    streaming = null;
    return;
  }

  // Full replay, used when the view is (re-)created — the webview is blank
  // after a panel move, but the conversation isn't.
  if (msg.type === 'chat-thread') {
    transcript.replaceChildren();
    for (const t of msg.turns || []) addTurn(t.speaker, t.text);
    return;
  }

  if (msg.type === 'mode') {
    modeButton.textContent = msg.short;
    modeButton.dataset.safe = String(msg.safe);
    modeButton.title = msg.detail;
    return;
  }

  if (msg.type === 'model-info') {
    modelsButton.title = msg.text;
    return;
  }

  if (msg.type === 'mute') {
    muteButton.dataset.muted = String(msg.muted);
    muteButton.textContent = msg.muted ? 'Muted' : 'Mute';
    return;
  }

  // Mute has to reach speechSynthesis too: it lives in here, not in the host,
  // so killing the native player alone would leave the OS voice talking.
  if (msg.type === 'stop-speech') {
    try { speechSynthesis.cancel(); } catch (err) { /* nothing to cancel */ }
    return;
  }

  if (msg.type === 'state' && typeof setState === 'function') {
    setState(msg.name);
    return;
  }

  // Speak via the OS voice. The mouth and the sound are the same component, so
  // they can't drift apart: playback events drive the avatar, not a timer.
  if (msg.type === 'speak-system') {
    try {
      const utterance = new SpeechSynthesisUtterance(msg.text);
      if (msg.voiceId) {
        const match = speechSynthesis.getVoices().find(v => v.name === msg.voiceId);
        if (match) utterance.voice = match;
      }
      utterance.onend = () => vscode.postMessage({ type: 'speech-ended', id: msg.id });
      utterance.onerror = (e) => vscode.postMessage({
        type: 'speech-error', id: msg.id, reason: (e && e.error) || 'unknown'
      });
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    } catch (err) {
      vscode.postMessage({ type: 'speech-error', id: msg.id, reason: String(err) });
    }
    return;
  }

  // Play pre-rendered audio handed over as a data URI. The webview never fetches
  // anything itself, so the API key never crosses the CSP boundary.
  if (msg.type === 'speak-audio') {
    try {
      const audio = new Audio(msg.dataUri);
      audio.onended = () => vscode.postMessage({ type: 'speech-ended', id: msg.id });
      audio.onerror = () => vscode.postMessage({
        type: 'speech-error', id: msg.id, reason: 'audio element error'
      });
      // play() rejects when autoplay policy blocks it. Swallowing that rejection
      // turns a clear NotAllowedError into a silent 60s timeout, so it is
      // reported rather than ignored.
      audio.play().catch((err) => {
        // A rejection here means this document's user activation is gone — the
        // webview can be re-created (panel moved, editor reloaded), and the
        // grant does not survive it. Re-arm the listeners so the next click
        // restores audio instead of leaving it permanently broken.
        if (err && err.name === 'NotAllowedError') {
          audioUnlocked = false;
          vscode.postMessage({ type: 'audio-locked' });
          window.addEventListener('pointerdown', unlockAudio, { once: true });
          window.addEventListener('keydown', unlockAudio, { once: true });
        }
        vscode.postMessage({
          type: 'speech-error',
          id: msg.id,
          reason: 'play() rejected: ' + (err && err.name ? err.name : String(err)),
        });
      });
    } catch (err) {
      vscode.postMessage({ type: 'speech-error', id: msg.id, reason: String(err) });
    }
    return;
  }

  if (msg.type === 'list-system-voices') {
    const voices = speechSynthesis.getVoices().map(v => ({ name: v.name, lang: v.lang }));
    vscode.postMessage({ type: 'system-voices', voices });
  }
});
