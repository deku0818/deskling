#!/usr/bin/env node
// Installs the Deskling collector for the current user.
//   node collector/install.mjs --hub http://192.168.1.10:8787 --token <INGEST_TOKEN> --source mac [--claude /path/to/claude]
//   node collector/install.mjs --uninstall
// Copies the scripts to ~/.deskling/bin, writes ~/.deskling/config.json, and adds Deskling hooks
// to ~/.claude/settings.json next to existing entries (a backup is kept).
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './lib.mjs';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const SCRIPTS = ['lib.mjs', 'deskling-hook.mjs', 'deskling-usage.mjs', 'codex.mjs', 'deskling-codex.mjs', 'deskling-codex-hook.mjs'];
const MARK = 'deskling-';

const args = process.argv.slice(2);
const option = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const settingsPath = process.env.CLAUDE_SETTINGS ?? path.join(homedir(), '.claude', 'settings.json');
const bin = path.join(HOME, 'bin');
const here = path.dirname(fileURLToPath(import.meta.url));
const command = script => `"${process.execPath}" "${path.join(bin, script)}"`;
const isOurs = hook => typeof hook?.command === 'string' && hook.command.includes(MARK);

function readSettings() {
  return existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
}

function writeSettings(settings) {
  if (existsSync(settingsPath)) {
    const backup = `${settingsPath}.deskling-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(settingsPath, backup);
    console.log(`backup: ${backup}`);
  }
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

// Removes only Deskling's hook entries, leaving every other hook untouched.
function removeOurs(settings) {
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups
      .map(group => ({ ...group, hooks: (group.hooks ?? []).filter(h => !isOurs(h)) }))
      .filter(group => group.hooks.length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  // Earlier versions installed a status line.
  if (isOurs(settings.statusLine)) delete settings.statusLine;
}

const settings = readSettings();
removeOurs(settings);

if (args.includes('--uninstall')) {
  writeSettings(settings);
  console.log(`Deskling hooks removed. Local data stays in ${HOME}.`);
  process.exit(0);
}

const hubUrl = option('hub'), token = option('token'), source = option('source');
if (!hubUrl || !token || !source) {
  console.error('usage: node install.mjs --hub <url> --token <ingest token> --source <machine name>');
  process.exit(1);
}

mkdirSync(bin, { recursive: true });
for (const script of SCRIPTS) {
  copyFileSync(path.join(here, script), path.join(bin, script));
  chmodSync(path.join(bin, script), 0o755);
}
// Hooks may run with a minimal PATH, so the quota reader gets an absolute path to claude.
let claudeBin = option('claude');
if (!claudeBin) {
  try {
    claudeBin = execSync('command -v claude', { encoding: 'utf8' }).trim() || undefined;
  } catch {}
}
if (!claudeBin) console.warn('claude was not found on PATH, so this machine will not report quota (pass --claude <path>).');
let codexBin = option('codex');
if (!codexBin) { try { codexBin = execSync('command -v codex', { encoding: 'utf8' }).trim() || undefined; } catch {} }
writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ hubUrl, token, source, claudeBin, codexBin }, null, 2) + '\n', { mode: 0o600 });

settings.hooks ??= {};
for (const event of EVENTS) {
  (settings.hooks[event] ??= []).push({ hooks: [{ type: 'command', command: command('deskling-hook.mjs'), async: true }] });
}
writeSettings(settings);
console.log(`Deskling collector installed: source "${source}" -> ${hubUrl}${claudeBin ? `, quota via ${claudeBin}` : ''}`);
console.log('Running Claude Code sessions pick up the new hooks after a restart.');

console.log('Start the Codex collector: node ~/.deskling/bin/deskling-codex.mjs');
