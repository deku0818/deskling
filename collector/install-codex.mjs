#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './lib.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const hooksFile = path.join(process.env.DESKLING_CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'hooks.json');
const bin = path.join(HOME, 'bin');
const mark = 'deskling-codex-hook.mjs';
const config = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, 'utf8')) : {};
for (const [event, groups] of Object.entries(config.hooks ?? {})) {
  const kept = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !hook.command?.includes(mark)) })).filter(group => group.hooks.length);
  if (kept.length) config.hooks[event] = kept; else delete config.hooks[event];
}
if (!process.argv.includes('--uninstall')) {
  if (!existsSync(path.join(HOME, 'config.json'))) throw new Error('Run the main collector installer first.');
  mkdirSync(bin, { recursive: true });
  for (const script of ['lib.mjs', 'codex.mjs', 'deskling-codex.mjs', mark]) copyFileSync(path.join(root, script), path.join(bin, script));
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const command = `${quote(process.execPath)} ${quote(path.join(bin, mark))}`;
  config.hooks ??= {};
  for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt']) {
    (config.hooks[event] ??= []).push({ hooks: [{ type: 'command', command, async: event !== 'SessionEnd', timeout: 3 }] });
  }
}
mkdirSync(path.dirname(hooksFile), { recursive: true });
if (existsSync(hooksFile)) copyFileSync(hooksFile, `${hooksFile}.deskling-backup-${Date.now()}`);
writeFileSync(hooksFile, JSON.stringify(config, null, 2) + '\n');
console.log(`Updated ${hooksFile}; existing unrelated hooks retained.`);
if (!process.argv.includes('--uninstall')) console.log('Review the Deskling hooks in Codex /hooks before enabling them. Trust settings were not changed.');
