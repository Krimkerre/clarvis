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
//
// The capture half is reported for the same reason and answers a question that
// decides whether routing recording through here is possible at all: a webview
// is a cross-origin iframe, and `getUserMedia` in one is refused unless the
// *parent* document grants `allow="microphone"` on the iframe element. That
// iframe belongs to the workbench, not to Clarvis, so no amount of extension
// code can make capture work if the policy says no. `mediaDevices` being
// present is necessary and not sufficient; `permissionsPolicy` is the part that
// actually decides, where the browser exposes it.
vscode.postMessage({
  type: 'audio-probe',
  speechSynthesis: typeof window.speechSynthesis !== 'undefined',
  audioElement: typeof window.Audio !== 'undefined',
  mediaDevices: typeof navigator.mediaDevices !== 'undefined',
  getUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
  // `document.featurePolicy` is the older name and still what some engines ship.
  microphoneAllowed: (() => {
    try {
      const policy = document.permissionsPolicy ?? document.featurePolicy;
      if (!policy || typeof policy.allowsFeature !== 'function') return 'unknown';
      return policy.allowsFeature('microphone') ? 'yes' : 'no';
    } catch {
      return 'unknown';
    }
  })(),
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
  // Whether this webview may open a microphone, answered by trying.
  //
  // Reached only from a command the operator ran: `getUserMedia` prompts, and a
  // panel that asked for the microphone every time it loaded would train people
  // to dismiss the prompt. The track is stopped the instant it opens — this
  // establishes permission, it does not record anything.
  if (msg.type === 'probe-capture') {
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const label = stream.getAudioTracks()[0]?.label ?? '';
        stream.getTracks().forEach((track) => track.stop());
        vscode.postMessage({ type: 'capture-probe', ok: true, device: label });
      } catch (err) {
        // The name is the useful half: `NotAllowedError` from a permissions
        // policy and from a user clicking "block" look identical here, and both
        // differ from `NotFoundError`, which means there is no input at all.
        vscode.postMessage({
          type: 'capture-probe',
          ok: false,
          error: (err && err.name) || String(err),
          detail: (err && err.message) || '',
        });
      }
    })();
    return;
  }

  // Record from the listener's own microphone and hand the clip to the host.
  //
  // **The mirror of `speak-audio`.** Capture on the extension host records the
  // machine running the server, which on a browser or remote host is not the
  // person at the keyboard — the same defect playback had. This is the input
  // half of the same route.
  //
  // **Raw PCM into a WAV, not MediaRecorder.** MediaRecorder is far less code
  // and produces Opus in a container, which the host's `peakDbfs` cannot read —
  // and that check is the only thing separating "recorded audio" from "recorded
  // silence from a denied device". Losing it to save twenty lines would give
  // back the exact guarantee this file spent the morning repairing. So the WAV
  // is built here, in the format the host recorder already produced.
  if (msg.type === 'record-audio') {
    (async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        vscode.postMessage({
          type: 'recorded', id: msg.id, ok: false,
          error: (err && err.name) || String(err),
        });
        return;
      }

      const context = new (window.AudioContext || window.webkitAudioContext)();
      const source = context.createMediaStreamSource(stream);
      // Deprecated, and the alternative is an AudioWorklet whose module has to
      // be fetched from a URL — which this document's CSP (`script-src
      // 'nonce-…'`) will not load from a blob. Deprecated and working beats
      // modern and blocked.
      const processor = context.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      let frames = 0;

      processor.onaudioprocess = (event) => {
        // Copied, because the browser reuses the underlying buffer between
        // callbacks and keeping the reference would hand the host the same few
        // milliseconds repeated.
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
        frames += input.length;
      };

      source.connect(processor);
      // Chromium will not run a ScriptProcessor that is not connected onward.
      // A zero-gain node keeps it scheduled without routing the microphone to
      // the speakers, which would be a feedback loop.
      const mute = context.createGain();
      mute.gain.value = 0;
      processor.connect(mute);
      mute.connect(context.destination);

      await new Promise((done) => setTimeout(done, (msg.seconds || 3) * 1000));

      processor.disconnect();
      mute.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      const rate = context.sampleRate;
      await context.close();

      vscode.postMessage({
        type: 'recorded', id: msg.id, ok: true,
        sampleRate: rate,
        device: stream.getAudioTracks()[0]?.label ?? '',
        wavBase64: wavFromFloat(chunks, frames, rate),
      });
    })();
    return;
  }

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


/**
 * A 16-bit mono WAV from captured float samples.
 *
 * Written here rather than on the host so the bytes crossing the boundary are
 * already the format every existing reader expects — `peakDbfs` walks the RIFF
 * chunks and measures int16 samples, and handing it anything else would mean
 * either a decoder on the host or losing the silence check.
 */
function wavFromFloat(chunks, frames, sampleRate) {
  const header = 44;
  const buffer = new ArrayBuffer(header + frames * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * 2, true);

  let offset = header;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      // Clamped before scaling: a float above 1 would wrap to a large negative
      // int16 and read as full-scale noise in a clip that merely clipped.
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const STEP = 0x8000; // apply() has an argument limit; chunk the conversion
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
