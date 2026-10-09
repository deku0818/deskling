// Read-only Codex adapter. Never resumes threads or starts inference.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';

export function usagePayload(result) {
  const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const usage = { five_hour: null, seven_day: null, model_scoped: [] };
  for (const window of [bucket?.primary, bucket?.secondary]) {
    if (!window || !Number.isFinite(window.usedPercent)) continue;
    const key = window.windowDurationMins === 300 ? 'five_hour' : window.windowDurationMins === 10080 ? 'seven_day' : null;
    if (key) usage[key] = { utilization: window.usedPercent,
      resets_at: Number.isFinite(window.resetsAt) ? new Date(window.resetsAt * 1000).toISOString() : null };
  }
  return usage;
}

export function runtimeState(status) {
  if (status?.type === 'active') return status.activeFlags?.length ? 'waiting' : 'working';
  if (status?.type === 'systemError') return 'error';
  if (status?.type === 'idle') return 'idle';
  return null; // notLoaded does not mean idle in another Codex process.
}

export function rolloutState(records) {
  let state = null, ts = 0, boundaryTs = 0;
  const waiting = new Set();
  for (const record of records) {
    const payload = record.payload ?? {}, time = Date.parse(record.timestamp);
    if (!Number.isFinite(time)) continue;
    if (record.type === 'event_msg') {
      if (state === null && ['item_completed', 'token_count'].includes(payload.type)) state = 'working';
      if (['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)) boundaryTs = time;
      if (payload.type === 'task_started') { state = 'working'; waiting.clear(); }
      if (payload.type === 'task_complete') { state = 'done'; waiting.clear(); }
      if (payload.type === 'turn_aborted') { state = 'idle'; waiting.clear(); }
      if (payload.type === 'error' && payload.will_retry !== true) state = 'error';
      // Rollout activity is a heartbeat even if the state did not change.
      ts = time;
    }
    if (record.type === 'response_item') {
      const type = payload.type;
      if (state === null) state = 'working';
      if ((type === 'function_call' || type === 'custom_tool_call') &&
          /(?:^|__)(?:request_user_input|request_user_input_async)$/.test(payload.name ?? '')) {
        waiting.add(payload.call_id); state = 'waiting';
      }
      if ((type === 'function_call_output' || type === 'custom_tool_call_output') && waiting.delete(payload.call_id)) {
        state = waiting.size ? 'waiting' : 'working';
      }
      ts = time;
    }
  }
  return { state: state ?? 'idle', ts, boundaryTs };
}

export function readRollout(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size, length = Math.min(size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift();
    const records = [];
    for (const line of lines) { try { records.push(JSON.parse(line)); } catch {} }
    return rolloutState(records);
  } catch { return { state: 'idle', ts: 0 }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function codexHookState(input) {
  if (input.agent_id || input.parent_thread_id) return null;
  switch (input.hook_event_name) {
    case 'SessionStart': return input.source === 'compact' ? 'working' : 'idle';
    case 'UserPromptSubmit': case 'PostToolUse': return 'working';
    case 'PreToolUse': return /(?:^|__)(request_user_input|AskUserQuestion)$/.test(input.tool_name ?? '') ? 'waiting' : 'working';
    case 'PermissionRequest': return 'waiting';
    case 'Stop': return 'done';
    case 'Interrupt': return 'idle';
    case 'SessionEnd': return 'stopped';
    default: return null;
  }
}
export function hookStatePath(home, id) {
  return path.join(home, 'codex-hook-state', createHash('sha256').update(id).digest('hex') + '.json');
}
export function observedState(home, threadId, rollout) {
  try {
    const hook = JSON.parse(readFileSync(hookStatePath(home, threadId), 'utf8'));
    if (['idle','working','waiting','done','error','stopped'].includes(hook.state) && hook.ts >= (rollout.boundaryTs ?? 0)) return hook.state;
  } catch {}
  return rollout.state;
}

export function isChildSession(input) {
  if (input.agent_id || input.parent_thread_id) return true;
  if (!input.transcript_path) return false;
  let fd;
  try {
    fd = openSync(input.transcript_path, 'r');
    const buffer = Buffer.alloc(256 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.indexOf(10, 0);
    if (end < 0 || end >= length) return false;
    const first = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    const source = first.type === 'session_meta' ? first.payload?.source : null;
    return !!(typeof source === 'object' && source?.subAgent);
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
