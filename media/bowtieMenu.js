// The bowtie's fold-out menu (plan.md M15, C2b+; the owner's decisions of 14 September 2026).
//
// Clicking the bowtie by the prompt opens this instead of going straight to the model pickers. First, API config:
// exactly what the bowtie did before, through the same `models` message, so choosing a provider or a model is
// unchanged. Under it, a Codex section: which Codex model a new task runs, how hard it thinks, and how much of the
// ChatGPT plan's allowance is left. The extension host fills the section each time the menu opens (a `codex-menu`
// message answering `bowtie-menu`); nothing is asked for while it is closed.
//
// It closes on Escape, on a click anywhere outside it, and after a choice. From the keyboard: the bowtie opens it
// with focus on API config, Tab and Shift+Tab stay inside it while it is open, and Escape puts focus back on the
// bowtie.
//
// Everything RAVIS sends reaches the page as text — textContent and title, never markup — because a model's name
// and a window's label come from outside Clarvis.
//
// A plain script, inlined under the webview's nonce before `media/chat.js`, which creates the menu. The tests load it
// too (`src/panels/bowtieMenu.test.ts`), which is why it touches only the elements it is handed and the document.
(function (root) {
  'use strict';

  function createBowtieMenu(env) {
    const doc = env.document;
    const button = env.button;
    const panel = env.panel;
    const post = env.post;
    let isOpen = false;
    let state = null;

    const make = (tag, className, part) => {
      const node = doc.createElement(tag);
      node.className = className;
      if (part) node.setAttribute('data-part', part);
      return node;
    };
    const say = (node, text) => {
      node.textContent = text ? String(text) : '';
      node.hidden = !text;
    };

    const apiConfig = make('button', 'clarvis-menu-item', 'api-config');
    apiConfig.type = 'button';
    const apiLabel = make('span', 'label');
    apiLabel.textContent = 'API config';
    const apiDetail = make('span', 'detail');
    apiDetail.textContent = 'Providers, models and keys, for chat and coding';
    apiConfig.appendChild(apiLabel);
    apiConfig.appendChild(apiDetail);

    const section = make('div', 'clarvis-menu-section', 'codex');
    section.setAttribute('role', 'group');
    const heading = make('div', 'clarvis-menu-heading');
    heading.id = 'clarvis-menu-codex-heading';
    heading.textContent = 'Codex';
    section.setAttribute('aria-labelledby', heading.id);
    const status = make('p', 'clarvis-menu-line', 'status');
    const modelLabel = make('div', 'clarvis-menu-label', 'model-label');
    modelLabel.textContent = 'Model';
    const models = make('div', 'clarvis-menu-options', 'models');
    models.setAttribute('role', 'radiogroup');
    models.setAttribute('aria-label', 'Codex model');
    const effortLabel = make('div', 'clarvis-menu-label', 'effort-label');
    effortLabel.textContent = 'Effort';
    const efforts = make('div', 'clarvis-menu-options clarvis-menu-segmented', 'efforts');
    efforts.setAttribute('role', 'radiogroup');
    efforts.setAttribute('aria-label', 'Effort');
    const note = make('p', 'clarvis-menu-note', 'note');
    const running = make('p', 'clarvis-menu-note', 'running');
    const allowance = make('p', 'clarvis-menu-allowance', 'allowance');
    [heading, status, modelLabel, models, effortLabel, efforts, note, running, allowance].forEach((node) => section.appendChild(node));

    panel.replaceChildren(apiConfig, section);
    panel.hidden = true;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');

    button.addEventListener('click', () => (isOpen ? close(true) : open()));
    apiConfig.addEventListener('click', () => {
      close(true);
      post({ type: 'models' });
    });
    doc.addEventListener('keydown', (event) => {
      if (!isOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      } else if (event.key === 'Tab') {
        keepTabInside(event);
      }
    });
    doc.addEventListener('pointerdown', (event) => {
      if (isOpen && !panel.contains(event.target) && !button.contains(event.target)) close(false);
    });

    function open() {
      isOpen = true;
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      draw({ enabled: false, line: 'Asking RAVIS…', models: [] });
      post({ type: 'bowtie-menu' });
      apiConfig.focus();
    }

    function close(returnFocus) {
      if (!isOpen) return;
      isOpen = false;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (returnFocus) button.focus();
    }

    // The host's answer. Drawn at once while the menu is open; one that arrives after it closed is only kept.
    function render(next) {
      state = next || null;
      if (isOpen && state) draw(state);
    }

    function draw(shown) {
      const list = Array.isArray(shown.models) ? shown.models : [];
      const chosen = shown.chosen || {};
      const model = list.find((entry) => entry.id === chosen.model);
      const levels = model && Array.isArray(model.efforts) ? model.efforts : [];
      say(status, shown.line);
      models.replaceChildren(...list.map((entry) => option(entry.label, entry.isDefault, entry.id === chosen.model, () => choose(entry.id, undefined))));
      efforts.replaceChildren(...levels.map((level) => option(level.id, level.isDefault, level.id === chosen.effort, () => choose(model.id, level.id))));
      models.hidden = modelLabel.hidden = list.length === 0;
      efforts.hidden = effortLabel.hidden = levels.length === 0;
      say(note, list.length > 0 ? shown.note : '');
      say(running, shown.running);
      say(allowance, shown.allowance && shown.allowance.line);
      allowance.title = (shown.allowance && shown.allowance.tooltip) || '';
      section.setAttribute('aria-disabled', shown.enabled ? 'false' : 'true');
      section.classList.toggle('disabled', !shown.enabled);
      optionButtons().forEach((node) => {
        node.disabled = !shown.enabled;
      });
    }

    function option(label, isDefault, checked, pick) {
      const node = make('button', checked ? 'clarvis-menu-option checked' : 'clarvis-menu-option');
      node.type = 'button';
      node.setAttribute('role', 'radio');
      node.setAttribute('aria-checked', checked ? 'true' : 'false');
      const name = make('span', 'label');
      name.textContent = String(label);
      node.appendChild(name);
      if (isDefault) {
        const marker = make('span', 'default');
        marker.textContent = 'default';
        node.appendChild(marker);
      }
      node.addEventListener('click', pick);
      return node;
    }

    // A pick in a disabled section is no pick: the controls apply only while Codex is the coding engine.
    function choose(model, effort) {
      if (!state || !state.enabled) return;
      post({ type: 'codex-choice', model: model, effort: effort });
      close(true);
    }

    function optionButtons() {
      return [...models.children, ...efforts.children];
    }

    function keepTabInside(event) {
      const groups = [models, efforts].filter((group) => !group.hidden);
      const items = [apiConfig, ...groups.flatMap((group) => [...group.children])].filter((node) => !node.disabled);
      const at = items.indexOf(doc.activeElement);
      const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === -1 || at === items.length - 1 ? 0 : at + 1;
      event.preventDefault();
      items[next].focus();
    }

    return {
      open,
      close,
      render,
      get isOpen() {
        return isOpen;
      },
    };
  }

  root.ClarvisBowtieMenu = { createBowtieMenu };
})(typeof globalThis !== 'undefined' ? globalThis : this);
