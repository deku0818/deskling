import { Store, type StoreOptions, type PersistedState } from './state.ts';
import { PROVIDERS, type Provider, type IngestEvent, type Snapshot } from './protocol.ts';

export interface ProviderState { v: 2; providers: Record<Provider, PersistedState> }

// Each provider owns its dedupe keys, session ids, collectors and account quota.
export class ProviderStore {
  private stores: Record<Provider, Store>;
  constructor(options: Partial<StoreOptions> = {}) {
    this.stores = { claude: new Store(options), codex: new Store(options) };
  }
  apply(event: IngestEvent, now: number) {
    return this.stores[event.provider ?? 'claude'].apply(event, now);
  }
  prune(now: number) { for (const provider of PROVIDERS) this.stores[provider].prune(now); }
  snapshot(provider: Provider, seq: number, now: number): Snapshot {
    const snapshot = { ...this.stores[provider].snapshot(seq, now), provider };
    if (provider === 'codex') snapshot.quota.fable = null;
    return snapshot;
  }
  toJSON(): ProviderState {
    return { v: 2, providers: { claude: this.stores.claude.toJSON(), codex: this.stores.codex.toJSON() } };
  }
  load(data: ProviderState | PersistedState) {
    if ('providers' in data) {
      for (const provider of PROVIDERS) if (data.providers[provider]) this.stores[provider].load(data.providers[provider]);
    } else this.stores.claude.load(data); // Existing v1 data belongs to Claude.
  }
}
