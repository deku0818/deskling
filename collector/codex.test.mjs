import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { usagePayload, runtimeState, rolloutState, codexHookState, observedState, hookStatePath } from './codex.mjs';
const record = (type, payload, n = 0) => ({ type, payload, timestamp: new Date(1000 + n).toISOString() });
test('weekly primary window stays weekly and missing quota stays null', () => {
  const usage = usagePayload({ rateLimits: { primary: { usedPercent: 83, windowDurationMins: 10080, resetsAt: 2000 } } });
  assert.equal(usage.five_hour, null); assert.equal(usage.seven_day.utilization, 83);
  assert.equal(usagePayload({}).five_hour, null);
  assert.equal(usagePayload({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: 60 } } }).five_hour, null);
});
test('unloaded is unknown, approvals wait, runtime errors fail', () => {
  assert.equal(runtimeState({ type: 'notLoaded' }), null);
  assert.equal(runtimeState({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'waiting');
  assert.equal(runtimeState({ type: 'active', activeFlags: [] }), 'working');
  assert.equal(runtimeState({ type: 'systemError' }), 'error');
});
test('rollout handles user input, completion and interruption without reading message text', () => {
  const events = [record('event_msg', { type: 'task_started' })];
  assert.equal(rolloutState(events).state, 'working');
  events.push(record('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'a' }, 1));
  assert.equal(rolloutState(events).state, 'waiting');
  events.push(record('response_item', { type: 'function_call_output', call_id: 'a' }, 2));
  assert.equal(rolloutState(events).state, 'working');
  events.push(record('event_msg', { type: 'task_complete' }, 3));
  assert.equal(rolloutState(events).state, 'done');
  events.push(record('event_msg', { type: 'task_started' }, 4), record('event_msg', { type: 'turn_aborted' }, 5));
  assert.equal(rolloutState(events).state, 'idle'); assert.equal(rolloutState(events).ts, 1005);
});

test('a bounded tail inside a running turn is still working', () => {
  assert.equal(rolloutState([record('event_msg', { type: 'item_completed' })]).state, 'working');
  assert.equal(rolloutState([record('response_item', { type: 'function_call_output' })]).state, 'working');
  assert.equal(rolloutState([record('event_msg', { type: 'task_complete' }), record('event_msg', { type: 'token_count' }, 1)]).state, 'done');
});

test('official hooks normalize permission, tools, completion, interruption and child events', () => {
  assert.equal(codexHookState({ hook_event_name: 'PermissionRequest' }), 'waiting');
  assert.equal(codexHookState({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), 'working');
  assert.equal(codexHookState({ hook_event_name: 'PostToolUse' }), 'working');
  assert.equal(codexHookState({ hook_event_name: 'Stop' }), 'done');
  assert.equal(codexHookState({ hook_event_name: 'Interrupt' }), 'idle');
  assert.equal(codexHookState({ hook_event_name: 'SessionEnd' }), 'stopped');
  assert.equal(codexHookState({ hook_event_name: 'Stop', agent_id: 'child' }), null);
});
test('permission hooks win over persisted tool activity, then a new turn supersedes them', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'deskling-hook-test-'));
  try {
    const file = hookStatePath(home, '../unsafe-id');
    assert.ok(file.startsWith(home + path.sep));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ state: 'waiting', ts: 2000 }));
    assert.equal(observedState(home, '../unsafe-id', { state: 'working', ts: 3000, boundaryTs: 1000 }), 'waiting');
    assert.equal(observedState(home, '../unsafe-id', { state: 'working', ts: 4000, boundaryTs: 4000 }), 'working');
    assert.equal(observedState(home, 'another-session', { state: 'done', ts: 5000 }), 'done');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
