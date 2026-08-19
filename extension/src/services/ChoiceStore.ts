import type * as vscode from 'vscode';

import type { ProviderId } from '../providers/types.js';

/**
 * The user's remembered, non-secret choices: which model per provider, and
 * which provider when several keys are stored (TDD §6, §7).
 *
 * `globalState` is the right home for these and the wrong home for a key — the
 * split is deliberate. Nothing secret is ever written here.
 *
 * Model IDs are stored, never defaulted: there is no hardcoded model anywhere
 * in this extension (D9), so an empty store means "ask", not "use the usual".
 */
export class ChoiceStore {
  private static readonly MODEL_PREFIX = 'promptEnhancer.model.';
  private static readonly PROVIDER_KEY = 'promptEnhancer.provider';

  constructor(private readonly state: vscode.Memento) {}

  getModel(provider: ProviderId): string | undefined {
    const stored = this.state.get<string>(`${ChoiceStore.MODEL_PREFIX}${provider}`);
    return stored === undefined || stored.trim().length === 0 ? undefined : stored.trim();
  }

  async setModel(provider: ProviderId, model: string): Promise<void> {
    await this.state.update(`${ChoiceStore.MODEL_PREFIX}${provider}`, model);
  }

  async forgetModel(provider: ProviderId): Promise<void> {
    await this.state.update(`${ChoiceStore.MODEL_PREFIX}${provider}`, undefined);
  }

  /**
   * The prompt-once-and-remember answer to "which provider" when more than one
   * key is stored (§7). The `promptEnhancer.provider` *setting* that takes
   * precedence over this arrives with the other two adapters in Phase 3 — a
   * contribution lands in the phase that implements it.
   */
  getProvider(): ProviderId | undefined {
    return this.state.get<ProviderId>(ChoiceStore.PROVIDER_KEY);
  }

  async setProvider(provider: ProviderId): Promise<void> {
    await this.state.update(ChoiceStore.PROVIDER_KEY, provider);
  }
}
