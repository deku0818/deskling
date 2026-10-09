#!/usr/bin/env node
// Claude Code hook: forwards the few fields Deskling needs. Registered with "async": true,
// so it never delays Claude Code; failures are silent and events stay spooled.
import { spawn } from 'node:child_process';
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, readStdin, enqueue, flush, claimUsageRead } from './lib.mjs';

const PROMPT_CHARS = 24;
const TITLE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop']);
const TAIL_BYTES = 256 * 1024;
const PLACEHOLDER_TITLES = new Set(['New session']);
const USAGE_INTERVAL_MS = 30_000;

// The transcript records the session's current name (custom or AI-generated) as "custom-title" lines.
function transcriptTitle(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"custom-title"')) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'custom-title' && entry.customTitle && !PLACEHOLDER_TITLES.has(entry.customTitle)) return entry.customTitle;
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

try {
  const config = loadConfig();
  const input = await readStdin();
  if (config && input.session_id && input.hook_event_name) {
    const hook = { event: input.hook_event_name };
    if (input.tool_name) hook.tool = input.tool_name;
    if (input.notification_type) hook.notificationType = input.notification_type;
    if (input.error_type) hook.errorType = input.error_type;
    if (input.reason) hook.reason = String(input.reason).slice(0, 80);
    if (input.source) hook.source = input.source;
    if (input.agent_id) hook.agentId = input.agent_id;
    const title = input.session_title ?? (TITLE_EVENTS.has(hook.event) && input.transcript_path ? transcriptTitle(input.transcript_path) : null);
    if (title) hook.title = title;
    // Only a short opening of the prompt, as a fallback title; slash commands are not titles.
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (prompt && !/^[/<!]/.test(prompt)) hook.prompt = [...prompt].slice(0, PROMPT_CHARS).join('');
    enqueue(config, input.session_id, 'hook', hook);
    // Quota only changes while Claude Code is in use, so activity drives the reads.
    if (config.claudeBin && claimUsageRead((config.usageIntervalSec ?? 30) * 1000)) {
      const reader = path.join(path.dirname(fileURLToPath(import.meta.url)), 'deskling-usage.mjs');
      spawn(process.execPath, [reader], { detached: true, stdio: 'ignore' }).unref();
    }
    await flush(config);
  }
} catch {}
