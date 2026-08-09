/**
 * Two jobs, two models.
 *
 * Answering "what did that error mean?" and running a twelve-step agent task are
 * different workloads with different costs. Forcing one model to do both means either
 * paying frontier prices to be told which branch you're on, or handing real code to a
 * model that can't hold a tool loop together.
 *
 * So the *coding* model is configured separately — and, because the useful split is
 * usually "local for chat, hosted for the agent", the **provider** can differ too, not
 * just the model name.
 */
export type ModelRole = 'chat' | 'agent';

/** The raw settings, as read. Empty strings mean "not set". */
export interface RoleSettings {
  chatProvider: string;
  chatModel: string;
  agentProvider: string;
  agentModel: string;
}

export interface Resolved {
  provider: string;
  /** Empty means "use the provider's default model". */
  model: string;
  /** True when this role fell back to the chat configuration. */
  inherited: boolean;
}

/**
 * Works out what a role actually runs on.
 *
 * **Unset inherits rather than defaulting.** Someone who never touches the agent
 * settings gets one model everywhere, which is what a single-model user expects and
 * what keeps this feature invisible until it's wanted. Only an explicit value splits
 * them.
 *
 * The provider and the model inherit *independently*: setting only the agent model
 * means "same account, better model" — the common case — and requiring both to be set
 * would make that awkward for no reason.
 */
export function resolveRole(role: ModelRole, settings: RoleSettings): Resolved {
  if (role === 'chat') {
    return {
      provider: settings.chatProvider,
      model: settings.chatModel.trim(),
      inherited: false,
    };
  }

  const provider = settings.agentProvider.trim() || settings.chatProvider;
  const model = settings.agentModel.trim();

  // A model name belongs to the provider that offered it. If the agent uses a *different*
  // provider but no model of its own, the chat model would be meaningless there — so
  // it falls through to that provider's default instead of being carried across.
  const inheritedModel = provider === settings.chatProvider ? settings.chatModel.trim() : '';

  return {
    provider,
    model: model || inheritedModel,
    inherited: !settings.agentProvider.trim() && !settings.agentModel.trim(),
  };
}
