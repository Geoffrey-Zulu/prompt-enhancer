import type * as vscode from 'vscode';

import { ALL_PROVIDERS } from '../providers/registry.js';
import type { ProviderId } from '../providers/types.js';

/**
 * The whole of the extension's key-handling surface (TDD §7).
 *
 * Rules this class exists to make structural rather than remembered:
 *
 * - **`SecretStorage` only.** A key never touches `workspace.configuration`,
 *   workspace state, or `globalState`. Settings sync and workspace files are
 *   the two places a key must not end up- which is also why
 *   `promptEnhancer.model` can be a setting and the key never can.
 * - **One key per provider**, so a user with several keeps them all and
 *   switching provider does not mean re-pasting.
 * - **Read per call, never cached in a module-level variable.** There is no
 *   field on this class holding a key, and no memoisation anywhere.
 * - **Never logged or messaged.** No method here logs, and nothing returns a
 *   key inside an error. Anything that does reach the log goes through
 *   `log.ts`, which redacts unconditionally (§9.3).
 */
export class SecretService {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** `promptEnhancer.apiKey.<provider>` (§7). */
  static storageKey(provider: ProviderId): string {
    return `promptEnhancer.apiKey.${provider}`;
  }

  async getKey(provider: ProviderId): Promise<string | undefined> {
    const stored = await this.secrets.get(SecretService.storageKey(provider));
    if (stored === undefined) {
      return undefined;
    }
    const key = stored.trim();
    return key.length === 0 ? undefined : key;
  }

  /** Rotation: this overwrites one provider's key and leaves the others alone. */
  async setKey(provider: ProviderId, apiKey: string): Promise<void> {
    await this.secrets.store(SecretService.storageKey(provider), apiKey.trim());
  }

  /**
   * Clearing removes the key; the extension then prompts on next use rather
   * than failing obscurely (§7).
   */
  async deleteKey(provider: ProviderId): Promise<void> {
    await this.secrets.delete(SecretService.storageKey(provider));
  }

  /** Which providers currently have a key stored, in `ALL_PROVIDERS` order. */
  async storedProviders(): Promise<ProviderId[]> {
    const found: ProviderId[] = [];
    for (const provider of ALL_PROVIDERS) {
      if ((await this.getKey(provider)) !== undefined) {
        found.push(provider);
      }
    }
    return found;
  }
}
