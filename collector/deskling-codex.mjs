#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { HOME, loadConfig, enqueue, flush } from './lib.mjs';
import { usagePayload, runtimeState, readRollout, observedState } from './codex.mjs';

const loaded = loadConfig();
if (!loaded) throw new Error('Install the Deskling collector or provide DESKLING_HOME/config.json first.');
const config = { ...loaded, provider: 'codex' };
const once = process.argv.includes('--once');
const RETAIN_MS = 30 * 60_000;
let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });

async function run() {
  const child = spawn(config.codexBin ?? 'codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let nextId = 0, failed = null;
  const pending = new Map();
  const rejectAll = error => {
    failed = error;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  child.on('error', rejectAll);
  child.on('exit', () => rejectAll(new Error('Codex App Server exited')));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  function call(method, params = {}) {
    if (failed) return Promise.reject(failed);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  const sent = new Map();
  let lastUsage = 0;
  try {
    await call('initialize', { clientInfo: { name: 'deskling', title: 'Deskling', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    console.log('Deskling Codex collector connected (read-only).');
    do {
      const now = Date.now(), threads = [];
      let cursor = null;
      do {
        const page = await call('thread/list', { limit: 100, sortKey: 'updated_at', useStateDbOnly: true, cursor });
        threads.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      const visible = new Set();
      for (const thread of threads) {
        if (thread.parentThreadId || (typeof thread.source === 'object' && thread.source?.subAgent)) continue;
        const rollout = thread.path ? readRollout(thread.path) : { state: 'idle', ts: 0 };
        const state = runtimeState(thread.status) ?? observedState(HOME, thread.id, rollout);
        if (state === 'stopped') continue;
        const ts = rollout.ts || thread.updatedAt * 1000;
        if (now - ts > RETAIN_MS && thread.status?.type !== 'active') continue;
        visible.add(thread.id);
        const title = String(thread.name || thread.preview || '新会话').replace(/\s+/g, ' ').slice(0, 64);
        const fingerprint = JSON.stringify([state, title, ts]);
        if (sent.get(thread.id) !== fingerprint) {
          enqueue(config, thread.id, 'hook', { event: 'Status', state, title });
          sent.set(thread.id, fingerprint);
        }
      }
      for (const id of sent.keys()) if (!visible.has(id)) {
        enqueue(config, id, 'hook', { event: 'SessionEnd' }); sent.delete(id);
      }
      if (now - lastUsage >= 60_000) {
        try {
          enqueue(config, undefined, 'usage', usagePayload(await call('account/rateLimits/read')));
          lastUsage = now;
        } catch { console.warn('Codex quota unavailable; retrying later.'); lastUsage = now; }
      }
      await flush(config);
      if (once) break;
      for (let i = 0; i < 10 && !stopped; i++) await new Promise(resolve => setTimeout(resolve, 500));
    } while (!stopped);
  } finally {
    rejectAll(new Error('collector stopping'));
    lines.close(); child.kill();
  }
}
do {
  try { await run(); }
  catch (error) { console.warn(`Codex collector: ${error.message}`); if (once) process.exitCode = 1; }
  if (!once && !stopped) for (let i = 0; i < 10 && !stopped; i++) await new Promise(resolve => setTimeout(resolve, 500));
} while (!once && !stopped);
