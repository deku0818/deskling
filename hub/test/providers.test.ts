import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderStore } from '../src/providers.ts';
import { Store, isValidEvent } from '../src/state.ts';
import type { IngestEvent, Provider } from '../src/protocol.ts';

const event = (provider: Provider, state: 'working' | 'waiting', used: number): IngestEvent[] => [
  { provider, source: 'mac', eventId: 'same-hook-id', ts: 1000, kind: 'hook', sessionId: 'same-session', hook: { event: 'Status', state, title: provider } },
  { provider, source: 'mac', eventId: 'same-usage-id', ts: 1000, kind: 'usage', usage: { five_hour: { utilization: used } } },
];
test('providers isolate ids, priority, collectors and quota across persistence', () => {
  const store = new ProviderStore();
  for (const e of [...event('claude', 'waiting', 90), ...event('codex', 'working', 20)]) store.apply(e, 1000);
  const restored = new ProviderStore(); restored.load(JSON.parse(JSON.stringify(store)));
  for (const s of [store, restored]) {
    const claude = s.snapshot('claude', 1, 1000), codex = s.snapshot('codex', 2, 1000);
    assert.equal(claude.overall, 'waiting'); assert.equal(codex.overall, 'working');
    assert.deepEqual(claude.sessions.map(s => s.title), ['claude']);
    assert.deepEqual(codex.sessions.map(s => s.title), ['codex']);
    assert.equal(claude.quota['5h']?.left, 10); assert.equal(codex.quota['5h']?.left, 80);
    assert.equal(codex.quota.fable, null); assert.equal(codex.provider, 'codex');
  }
});
test('v1 state and collectors migrate only to Claude', () => {
  const old = new Store();
  old.apply({ ...event('claude', 'working', 5)[0], provider: undefined }, 1000);
  const store = new ProviderStore(); store.load(old.toJSON());
  assert.equal(store.snapshot('claude', 1, 1000).sessions.length, 1);
  assert.equal(store.snapshot('codex', 1, 1000).sessions.length, 0);
  assert.equal(store.snapshot('codex', 1, 1000).collectors.length, 0);
});
test('unknown provider is rejected instead of falling through to Claude', () => {
  assert.equal(isValidEvent({ ...event('claude', 'waiting', 3)[0], provider: 'other' }), false);
  assert.equal(isValidEvent({ ...event('claude', 'waiting', 3)[0], provider: undefined }), true);
});
