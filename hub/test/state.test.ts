import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, overallState } from '../src/state.ts';
import { parseUsage } from '../src/usage.ts';
import type { HookPayload, IngestEvent } from '../src/protocol.ts';

let counter = 0;
const hook = (sessionId: string, ts: number, payload: HookPayload, source = 'mac'): IngestEvent =>
  ({ eventId: `e${++counter}`, source, ts, sessionId, kind: 'hook', hook: payload });

function run(store: Store, events: IngestEvent[], now = 1_000_000) {
  for (const e of events) store.apply(e, now);
  return store.snapshot(1, now);
}

test('a prompt, a permission request and a stop drive one session', () => {
  const store = new Store();
  let snap = run(store, [hook('s1', 1, { event: 'SessionStart', source: 'startup' })]);
  assert.equal(snap.sessions[0].state, 'idle');
  snap = run(store, [hook('s1', 2, { event: 'UserPromptSubmit', prompt: '修复登录鉴权问题' })]);
  assert.equal(snap.sessions[0].state, 'working');
  assert.equal(snap.sessions[0].title, '修复登录鉴权问题');
  snap = run(store, [hook('s1', 3, { event: 'PreToolUse', tool: 'Bash' }), hook('s1', 4, { event: 'PermissionRequest', tool: 'Bash' })]);
  assert.equal(snap.overall, 'waiting');
  snap = run(store, [hook('s1', 5, { event: 'PostToolUse', tool: 'Bash' })]);
  assert.equal(snap.overall, 'working');
  snap = run(store, [hook('s1', 6, { event: 'Stop' })]);
  assert.equal(snap.overall, 'done');
});

test('older events never overwrite a newer state', () => {
  const store = new Store();
  const snap = run(store, [hook('s1', 10, { event: 'Stop' }), hook('s1', 5, { event: 'PreToolUse', tool: 'Read' })]);
  assert.equal(snap.sessions[0].state, 'done');
});

test('duplicate event ids are applied once', () => {
  const store = new Store();
  const e = hook('s1', 1, { event: 'UserPromptSubmit' });
  assert.equal(store.apply(e, 0), true);
  assert.equal(store.apply(e, 0), false);
});

test('AskUserQuestion waits, subagent stops do not finish the session', () => {
  const store = new Store();
  let snap = run(store, [hook('s1', 1, { event: 'PreToolUse', tool: 'AskUserQuestion' })]);
  assert.equal(snap.sessions[0].state, 'waiting');
  snap = run(store, [hook('s1', 2, { event: 'PostToolUse', tool: 'AskUserQuestion' }), hook('s1', 3, { event: 'SubagentStop', agentId: 'a1' }), hook('s1', 4, { event: 'Stop', agentId: 'a1' })]);
  assert.equal(snap.sessions[0].state, 'working');
});

test('idle_prompt after an interrupted turn leaves working', () => {
  const store = new Store();
  const snap = run(store, [hook('s1', 1, { event: 'UserPromptSubmit' }), hook('s1', 2, { event: 'Notification', notificationType: 'idle_prompt' })]);
  assert.equal(snap.sessions[0].state, 'idle');
});

test('rate limit failures are limited, other failures are errors', () => {
  const store = new Store();
  const snap = run(store, [
    hook('s1', 1, { event: 'StopFailure', errorType: 'rate_limit' }),
    hook('s2', 1, { event: 'StopFailure', errorType: 'server_error' }),
  ]);
  assert.deepEqual(snap.sessions.map(s => s.state), ['limited', 'error']);
  assert.equal(snap.overall, 'error');
});

test('overall priority: waiting > error > working > done > idle > stopped', () => {
  const s = (state: string, stale = false) => ({ state: state as never, stale });
  assert.equal(overallState([]), 'idle');
  assert.equal(overallState([s('working'), s('waiting'), s('error')]), 'waiting');
  assert.equal(overallState([s('working'), s('error')]), 'error');
  assert.equal(overallState([s('done'), s('working')]), 'working');
  assert.equal(overallState([s('done'), s('idle')]), 'done');
  assert.equal(overallState([s('stopped')]), 'stopped');
  assert.equal(overallState([s('waiting', true), s('done')]), 'done');
  assert.equal(overallState([s('working', true)]), 'stopped');
});

test('session names win over the prompt fallback and can be renamed', () => {
  const store = new Store();
  let snap = run(store, [hook('s1', 1, { event: 'UserPromptSubmit', prompt: 'first prompt' })]);
  assert.equal(snap.sessions[0].title, 'first prompt');
  snap = run(store, [hook('s1', 2, { event: 'Stop', title: 'Deskling hub' })]);
  assert.equal(snap.sessions[0].title, 'Deskling hub');
  snap = run(store, [hook('s1', 3, { event: 'UserPromptSubmit', prompt: 'later prompt', title: 'Deskling hub v2' })]);
  assert.equal(snap.sessions[0].title, 'Deskling hub v2');
});

test('quota readings set remaining percent; null clears a window', () => {
  const store = new Store();
  store.setQuota('5h', 32.4, 5000, 1_000_000);
  store.setQuota('fable', 0, 9000, 1_000_000);
  let snap = store.snapshot(1, 1_000_000);
  assert.deepEqual(snap.quota['5h'], { left: 68, resetAt: 5000, at: 1000 });
  assert.equal(snap.quota.fable?.left, 100);
  assert.equal(snap.quota.week, null);
  store.setQuota('fable', null, null, 1_000_000);
  snap = store.snapshot(1, 1_000_000);
  assert.equal(snap.quota.fable, null);
});

test('parseUsage reads 5h, week and the Fable model window', () => {
  const readings = parseUsage({
    five_hour: { utilization: 2, resets_at: '2026-10-05T08:59:59.992837+00:00' },
    seven_day: { utilization: 40, resets_at: '2026-10-11T22:59:59.992865+00:00' },
    model_scoped: [{ display_name: 'Fable', utilization: 7, resets_at: '2026-10-11T23:00:00+00:00' }],
  });
  assert.deepEqual(readings, [
    { key: '5h', used: 2, resetAt: 1791190799 },
    { key: 'week', used: 40, resetAt: 1791759599 },
    { key: 'fable', used: 7, resetAt: 1791759600 },
  ]);
  assert.deepEqual(parseUsage({ five_hour: null }).map(r => r.used), [null, null, null]);
});

test('usage events from any machine update quota, newest reading wins', () => {
  const store = new Store();
  const usage = (source: string, ts: number, used: number): IngestEvent =>
    ({ eventId: `e${++counter}`, source, ts, kind: 'usage', usage: { five_hour: { utilization: used, resets_at: '2026-10-05T09:00:00Z' } } });
  store.apply(usage('mac', 2000, 10), 5000);
  store.apply(usage('aws', 1000, 50), 5000);
  let snap = store.snapshot(1, 5000);
  assert.deepEqual(snap.quota['5h'], { left: 90, resetAt: 1791190800, at: 2 });
  assert.equal(snap.sessions.length, 0, 'usage is not a session');
  assert.deepEqual(snap.collectors.map(c => c.source), ['aws', 'mac']);
  store.apply(usage('aws', 3000, 55), 6000);
  snap = store.snapshot(1, 6000);
  assert.equal(snap.quota['5h']?.left, 45);
});

test('silent working sessions become stale, then pruned with their collector', () => {
  const store = new Store();
  const t0 = 1_000_000;
  run(store, [hook('s1', 1, { event: 'UserPromptSubmit' })], t0);
  assert.equal(store.snapshot(1, t0 + 9 * 60_000).sessions[0].stale, false);
  const later = store.snapshot(1, t0 + 11 * 60_000);
  assert.equal(later.sessions[0].stale, true);
  assert.equal(later.overall, 'stopped');
  store.prune(t0 + 31 * 60_000);
  const pruned = store.snapshot(1, t0 + 31 * 60_000);
  assert.equal(pruned.sessions.length, 0);
  assert.equal(pruned.collectors.length, 0);
});

test('SessionEnd removes the session at once; late older events cannot revive it', () => {
  const store = new Store();
  const t0 = 1_000_000;
  run(store, [hook('s1', 1, { event: 'UserPromptSubmit' }), hook('s1', 5, { event: 'SessionEnd', reason: 'other' })], t0);
  assert.equal(store.snapshot(1, t0).sessions.length, 0);
  run(store, [hook('s1', 4, { event: 'PostToolUse', tool: 'Bash' })], t0);
  assert.equal(store.snapshot(1, t0).sessions.length, 0, 'an older event arriving late is ignored');
  run(store, [hook('s1', 9, { event: 'SessionStart', source: 'resume' }), hook('s1', 10, { event: 'UserPromptSubmit' })], t0);
  assert.equal(store.snapshot(1, t0).sessions[0].state, 'working', 'resuming brings it back');
  run(store, [hook('s2', 1, { event: 'SessionEnd' })], t0);
  assert.equal(store.snapshot(1, t0).sessions.length, 1, 'an end for an unknown session adds nothing');
});

test('at most 12 sessions, dropping the least recently active, in stable order', () => {
  const store = new Store();
  for (let i = 0; i < 14; i++) store.apply(hook(`s${i}`, 1, { event: 'UserPromptSubmit', prompt: `task ${i}` }), 1000 + i);
  const snap = store.snapshot(1, 3000);
  assert.equal(snap.sessions.length, 12);
  // The two least recently active sessions are left out; the rest keep first-seen order.
  assert.deepEqual(snap.sessions.map(s => s.title), Array.from({ length: 12 }, (_, i) => `task ${i + 2}`));
});

test('persisted state round-trips', () => {
  const store = new Store();
  run(store, [hook('s1', 1, { event: 'UserPromptSubmit', prompt: 'persist me' })]);
  const restored = new Store();
  restored.load(JSON.parse(JSON.stringify(store)));
  assert.deepEqual(restored.snapshot(1, 1_000_000), store.snapshot(1, 1_000_000));
});

test('snapshot ids are unique even when session ids share a prefix', () => {
  const store = new Store();
  const snap = run(store, [hook('exit-test-a', 1, { event: 'UserPromptSubmit' }), hook('exit-test-b', 1, { event: 'Stop' })]);
  assert.deepEqual(snap.sessions.map(s => s.id), ['mac:exit-test-a', 'mac:exit-test-b']);
});
