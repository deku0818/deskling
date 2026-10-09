#!/usr/bin/env node
// Reads account quota through Claude Code's SDK get_usage control request (the same data as /usage)
// and reports it to the hub. Claude Code handles the login; the request does not call the model.
// Started detached by the hook at most once per interval.
import { spawn } from 'node:child_process';
import { loadConfig, enqueue, flush } from './lib.mjs';

const TIMEOUT_MS = 15_000;

function getUsage(claudeBin) {
  return new Promise((resolve, reject) => {
    // No user settings, so Deskling's own hooks never see this helper as a session.
    const child = spawn(claudeBin, [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--setting-sources', '', '--no-session-persistence',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('get_usage timed out')), TIMEOUT_MS);
    child.on('error', finish);
    child.on('exit', code => finish(new Error(`claude exited (${code}) before answering`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type !== 'control_response' || message.response?.request_id !== 'usage') continue;
        if (message.response.subtype === 'success') finish(null, message.response.response);
        else finish(new Error(message.response.error ?? 'get_usage failed'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
  });
}

try {
  const config = loadConfig();
  if (config?.claudeBin) {
    const limits = (await getUsage(config.claudeBin))?.rate_limits;
    // Only the windows the display shows; spend and credit details stay on this machine.
    if (limits) {
      enqueue(config, undefined, 'usage', {
        five_hour: limits.five_hour ?? null,
        seven_day: limits.seven_day ?? null,
        model_scoped: Array.isArray(limits.model_scoped) ? limits.model_scoped : [],
      });
      await flush(config);
    }
  }
} catch {}
