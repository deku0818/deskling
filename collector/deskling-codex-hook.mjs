#!/usr/bin/env node
// Advisory lifecycle observer: writes no stdout and never approves or blocks tools.
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { HOME, loadConfig, readStdin, enqueue, flush } from './lib.mjs';
import { codexHookState, hookStatePath, isChildSession } from './codex.mjs';

try {
  const loaded = loadConfig(), input = await readStdin();
  const state = codexHookState(input);
  if (loaded && typeof input.session_id === 'string' && state && !isChildSession(input)) {
    const config = { ...loaded, provider: 'codex' };
    const file = hookStatePath(HOME, input.session_id), ts = Date.now();
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ state, ts }), { mode: 0o600 }); renameSync(tmp, file);
    const hook = state === 'stopped' ? { event: 'SessionEnd' } : { event: 'Status', state };
    if (input.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string') hook.prompt = [...input.prompt].slice(0, 24).join('');
    enqueue(config, input.session_id, 'hook', hook);
    await flush(config, 1500);
  }
} catch {}
