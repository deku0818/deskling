// Plays scripted Claude Code activity into a hub so the display can be tested without real sessions.
// Usage: npm run simulate [-- --speed 2] [-- --once]
import { randomUUID } from 'node:crypto';
import type { HookPayload, IngestEvent } from '../src/protocol.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const hubUrl = option('hub', process.env.HUB_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`);
const token = process.env.INGEST_TOKEN;
const speed = Number(option('speed', '1'));
const source = option('source', 'sim');
if (!token) throw new Error('INGEST_TOKEN is required');

const run = randomUUID().slice(0, 4);
const sid = (name: string) => `sim-${run}-${name}`;

type Step = [delaySec: number, session: string, payload: HookPayload];

// Quota is not simulated: the hub reads the real account quota itself.
// Three overlapping sessions: one asks for permission, one fails, all eventually finish.
const script: Step[] = [
  [0, 'ui', { event: 'SessionStart', source: 'startup', title: '桌搭屏幕布局设计' }],
  [1, 'ui', { event: 'UserPromptSubmit', prompt: '调整桌搭主屏布局' }],
  [1, 'ui', { event: 'PreToolUse', tool: 'Read' }],
  [2, 'sync', { event: 'SessionStart', source: 'startup' }],
  [0, 'sync', { event: 'UserPromptSubmit', prompt: 'Claude Code 使用额度同步' }],
  [2, 'ui', { event: 'PreToolUse', tool: 'Bash' }],
  [0.3, 'ui', { event: 'PermissionRequest', tool: 'Bash' }],
  [3, 'sync', { event: 'PreToolUse', tool: 'Edit' }],
  [4, 'ui', { event: 'PostToolUse', tool: 'Bash' }],
  [2, 'auth', { event: 'UserPromptSubmit', prompt: '修复 API 登录鉴权问题，并补充 refresh token 过期后的重试测试' }],
  [3, 'auth', { event: 'StopFailure', errorType: 'server_error', reason: 'simulated' }],
  [4, 'auth', { event: 'UserPromptSubmit', prompt: '再试一次' }],
  [3, 'ui', { event: 'Stop' }],
  [3, 'sync', { event: 'PreToolUse', tool: 'AskUserQuestion' }],
  [4, 'sync', { event: 'PostToolUse', tool: 'AskUserQuestion' }],
  [3, 'auth', { event: 'Stop' }],
  [3, 'sync', { event: 'Stop' }],
  [8, 'ui', { event: 'SessionEnd', reason: 'prompt_input_exit' }],
  [0, 'sync', { event: 'SessionEnd', reason: 'prompt_input_exit' }],
  [0, 'auth', { event: 'SessionEnd', reason: 'prompt_input_exit' }],
];

async function send(session: string, payload: Step[2]) {
  const base = { eventId: randomUUID(), source, ts: Date.now(), sessionId: sid(session) };
  const event: IngestEvent = { ...base, kind: 'hook', hook: payload };
  const res = await fetch(`${hubUrl}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: [event] }),
  });
  if (!res.ok) throw new Error(`hub answered ${res.status}: ${await res.text()}`);
  const label = payload.event + (payload.tool ? `(${payload.tool})` : '');
  console.log(`${new Date().toLocaleTimeString()}  ${session.padEnd(5)} ${label}`);
}

do {
  for (const [delay, session, payload] of script) {
    await new Promise(resolve => setTimeout(resolve, (delay * 1000) / speed));
    await send(session, payload);
  }
} while (!flag('once'));
