import * as vscode from 'vscode';
import { ModelService } from './ModelService';
import { ModelChoice } from './ModelProvider';
import { PROVIDERS, ProviderId, providerSpec } from './providers';
import { ModelRole } from './roles';
import { phrase } from '../personality/Voice';

/** Cached model lists, per provider. */
const CATALOG_KEY = 'clarvis.model.catalog';
const CATALOG_FETCHED_KEY = 'clarvis.model.catalogFetchedAt';

/**
 * How long a cached list is reused before it refetches on its own.
 *
 * Model line-ups change weekly, not hourly. Fetching on every picker open would be
 * rude to the provider and slow for the user; a day is comfortably inside "current"
 * and well outside "hammering them". Refresh is always available regardless.
 */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

type CatalogStore = Partial<Record<ProviderId, ModelChoice[]>>;
type FetchedStore = Partial<Record<ProviderId, number>>;

/**
 * Chooses the provider.
 *
 * Separate from choosing a model, because they are different decisions: the provider
 * is *who you have an account with*, the model is *which one you want today*.
 */
export async function chooseProvider(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void,
  role: ModelRole = 'chat'
): Promise<void> {
  const current = models.spec(role).id;
  const keyed = await models.keyedProviders();

  const picked = await vscode.window.showQuickPick(
    PROVIDERS.map((spec) => ({
      label: `${spec.id === current ? '$(check) ' : ''}${spec.label}`,
      detail: spec.detail,
      // The single thing that prevents "why won't it answer?" — said here, not later.
      description: spec.needsKey ? (keyed[spec.id] ? 'key set' : 'no key yet') : 'no key needed',
      id: spec.id,
    })),
    { placeHolder: 'Which provider should I use?', matchOnDetail: true }
  );
  if (!picked) return;

  await writeSetting(`${role}.provider`, picked.id);
  // A model belongs to the provider that offered it. Carrying one across means asking
  // OpenAI for a Claude model and getting a 404 nobody can explain.
  await writeSetting(`${role}.model`, '');
  log(`model: ${role} provider set to ${picked.id}`);

  const spec = providerSpec(picked.id)!;
  if (spec.needsKey && !keyed[picked.id]) {
    await promptForKey(models, picked.id, log);
  }

  // **Straight on to the models.** Choosing a provider clears the model — carrying one
  // across means asking OpenAI for a Claude model and getting a 404 nobody can explain —
  // so stopping here left the user with a provider and nothing to answer with, and no
  // sign that a second picker existed. The key prompt comes first, because the list
  // cannot be fetched without it.
  await chooseModel(context, models, log, role);
}

/**
 * Chooses the model, offering only ones that will actually work.
 *
 * Identical flow for every provider — the differences live in how each list is
 * *fetched and filtered* (see the catalogue modules), not in how it is presented.
 * Refresh sits inside the list rather than in a separate command, because the moment
 * someone wants it is the moment the model they are looking for isn't there.
 */
export async function chooseModel(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void,
  role: ModelRole = 'chat'
): Promise<void> {
  const spec = models.spec(role);
  const current = models.model(role);
  let catalog = await cachedModels(context, models, log, false, role);

  for (;;) {
    const items: (vscode.QuickPickItem & { id: string })[] = [
      { label: '$(refresh) Refresh the list', detail: `Re-fetch from ${spec.label}`, id: '\0refresh' },
      { label: '$(edit) Type a model name…', detail: 'Anything, including models not listed', id: '\0type' },
    ];

    if (catalog.length > 0) {
      items.push({
        label: `${catalog.length} usable model${catalog.length === 1 ? '' : 's'}`,
        kind: vscode.QuickPickItemKind.Separator,
        id: '\0sep',
      });
      items.push(
        ...catalog.map((entry) => ({
          label: entry.id === current ? `$(check) ${entry.label}` : entry.label,
          description: entry.label === entry.id ? '' : entry.id,
          detail: entry.detail,
          id: entry.id,
        }))
      );
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder:
        catalog.length > 0
          ? role === 'agent'
            ? `${spec.label} — the model that writes code`
            : `${spec.label} — the model that answers questions`
          : `${spec.label} listed nothing. Type a name, or refresh.`,
      matchOnDetail: true,
      matchOnDescription: true,
    });
    if (!picked) return;

    if (picked.id === '\0refresh') {
      catalog = await cachedModels(context, models, log, true, role);
      continue;
    }

    if (picked.id === '\0type') {
      await promptForModelName(current, log, role);
      return;
    }

    await writeSetting(`${role}.model`, picked.id);
    log(`model: ${role} model set to ${picked.id}`);
    return;
  }
}

/**
 * The model list, from cache or freshly fetched.
 *
 * Falls back to whatever is cached when a fetch fails: a stale list beats an empty
 * one, and a provider being briefly unreachable should not stop someone changing
 * models. Cached per provider, so switching back and forth doesn't refetch.
 */
async function cachedModels(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void,
  force: boolean,
  role: ModelRole = 'chat'
): Promise<ModelChoice[]> {
  const provider = models.spec(role).id;
  const store = context.globalState.get<CatalogStore>(CATALOG_KEY) ?? {};
  const fetched = context.globalState.get<FetchedStore>(CATALOG_FETCHED_KEY) ?? {};

  const cached = store[provider] ?? [];
  const fresh = Date.now() - (fetched[provider] ?? 0) < CATALOG_TTL_MS;
  if (!force && fresh && cached.length > 0) return cached;

  try {
    const listed = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Clarvis: asking ${models.spec(role).label}…` },
      () => models.listModels(role)
    );

    if (listed.length === 0) {
      log(`model: ${provider} listed no usable models`);
      return cached;
    }

    await context.globalState.update(CATALOG_KEY, { ...store, [provider]: listed });
    await context.globalState.update(CATALOG_FETCHED_KEY, { ...fetched, [provider]: Date.now() });
    log(`model: ${provider} catalogue refreshed, ${listed.length} usable models`);

    if (force) {
      void vscode.window.showInformationMessage(
        `Clarvis: ${listed.length} usable ${models.spec(role).label} models.`
      );
    }
    return listed;
  } catch (error) {
    log(`model: ${provider} catalogue fetch failed (${String(error)})`);
    return cached;
  }
}

/** Refreshes the current provider's list from the command palette. */
export async function refreshModelCatalog(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void
): Promise<void> {
  const listed = await cachedModels(context, models, log, true);
  if (listed.length === 0) {
    void vscode.window.showWarningMessage(
      `Clarvis: couldn't get a model list from ${models.spec().label} just now.`
    );
  }
}

/**
 * Asks which job is being configured, then configures it.
 *
 * One entry point rather than four separate commands: most people never split the two,
 * and those who do think in terms of "the coding one costs more", not in terms of
 * which setting key holds it.
 */
export async function configureModels(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void
): Promise<void> {
  const chatSpec = models.spec('chat');
  const agentSpec = models.spec('agent');
  const separate = models.agentIsSeparate();

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '$(comment-discussion) Chat model',
        description: `${chatSpec.label} · ${models.model('chat')}`,
        detail: 'Answers questions. Every reply you read costs this one.',
        id: 'chat',
      },
      {
        label: '$(tools) Coding model',
        description: separate
          ? `${agentSpec.label} · ${models.model('agent')}`
          : 'same as chat',
        detail: separate
          ? 'Writes code and runs the agent.'
          : 'Writes code and runs the agent. Set it separately to keep a cheap model for chat.',
        id: 'agent',
      },
      { label: '$(key) API keys', detail: 'One per provider, all kept', id: 'keys' },
    ],
    { placeHolder: 'What would you like to change?', matchOnDetail: true }
  );
  if (!picked) return;

  if (picked.id === 'keys') {
    await manageKeys(models, log);
    return;
  }

  const role = picked.id as ModelRole;
  const next = await vscode.window.showQuickPick(
    [
      { label: '$(server) Provider', detail: 'Which account or local runtime', id: 'provider' },
      { label: '$(list-selection) Model', detail: 'Which model at that provider', id: 'model' },
      ...(role === 'agent' && separate
        ? [{ label: '$(discard) Follow the chat model again', detail: 'Stop using a separate coding model', id: 'reset' }]
        : []),
    ],
    { placeHolder: role === 'agent' ? 'Coding model' : 'Chat model' }
  );
  if (!next) return;

  if (next.id === 'reset') {
    await writeSetting('agent.provider', '');
    await writeSetting('agent.model', '');
    log('model: agent follows the chat model again');
    return;
  }

  if (next.id === 'provider') await chooseProvider(context, models, log, role);
  else await chooseModel(context, models, log, role);
}

/**
 * Manages every provider's key in one place.
 *
 * Keys are stored **per provider and kept**, so switching provider is a one-click
 * change rather than re-entering a key each time. Someone comparing a local model
 * against a hosted one does that ten times in an afternoon.
 */
export async function manageKeys(models: ModelService, log: (m: string) => void): Promise<void> {
  for (;;) {
    const keyed = await models.keyedProviders();

    const picked = await vscode.window.showQuickPick(
      PROVIDERS.filter((spec) => spec.needsKey).map((spec) => ({
        label: `${keyed[spec.id] ? '$(key) ' : '$(circle-outline) '}${spec.label}`,
        description: keyed[spec.id] ? 'key stored' : 'no key',
        detail: keyed[spec.id] ? 'Choose to replace or remove it' : 'Choose to add one',
        id: spec.id,
      })),
      { placeHolder: 'API keys — stored in your OS keychain, one per provider' }
    );
    if (!picked) return;

    if (!keyed[picked.id]) {
      await promptForKey(models, picked.id, log);
      continue;
    }

    const action = await vscode.window.showQuickPick(
      [
        { label: '$(edit) Replace the key', id: 'replace' },
        { label: '$(trash) Remove the key', id: 'remove' },
      ],
      { placeHolder: `${providerSpec(picked.id)!.label}` }
    );
    if (!action) continue;

    if (action.id === 'replace') await promptForKey(models, picked.id, log);
    else {
      await models.clearKey(picked.id);
      void vscode.window.showInformationMessage(
        `Clarvis: ${providerSpec(picked.id)!.label} key removed.`
      );
    }
  }
}

/** Free-text model entry, for anything a provider doesn't list. */
async function promptForModelName(
  current: string,
  log: (m: string) => void,
  role: ModelRole = 'chat'
): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Model name, exactly as the provider spells it',
    value: current,
    ignoreFocusOut: true,
  });
  if (!name?.trim()) return;

  await writeSetting(`${role}.model`, name.trim());
  log(`model: ${role} model set to ${name.trim()} (typed)`);
}

/** Captures a key into the OS keychain. Never settings, never the log. */
export async function promptForKey(
  models: ModelService,
  provider: ProviderId,
  log: (m: string) => void
): Promise<void> {
  const spec = providerSpec(provider)!;

  const key = await vscode.window.showInputBox({
    prompt: `${spec.label} API key`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!key?.trim()) return;

  await models.setKey(provider, key);
  log(`model: key stored for ${provider}`);
  void vscode.window.showInformationMessage(
    await phrase('report', `${spec.label} key stored in the system keychain.`, [spec.label])
  );
}

/**
 * Writes to the scope that will actually take effect.
 *
 * Same trap the voice picker hit: writing Global unconditionally succeeds and does
 * nothing whenever a workspace value exists, and the setting appears to snap back.
 */
async function writeSetting(key: string, value: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('clarvis');
  const scope =
    config.inspect(key)?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

  await config.update(key, value, scope);
}
