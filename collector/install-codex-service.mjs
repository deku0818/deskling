#!/usr/bin/env node
// Keep the read-only Codex collector running independently of a terminal on macOS.
// Separate from hook installation so enabling the service never changes hook trust.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, loadConfig } from './lib.mjs';

export const LABEL = 'com.deskling.codex-collector';
const scripts = ['lib.mjs', 'codex.mjs', 'deskling-codex.mjs'];
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function servicePlist(home, nodeBin, searchPath = process.env.PATH ?? '/usr/bin:/bin') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(nodeBin)}</string><string>${xml(path.join(home, 'bin', 'deskling-codex.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(home)}</string>
  <key>EnvironmentVariables</key><dict><key>DESKLING_HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(searchPath)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(home, 'logs', 'codex-collector.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(home, 'logs', 'codex-collector.error.log'))}</string>
</dict></plist>
`;
}

export function manageService({ uninstall = false, home = HOME, agentsDir = path.join(homedir(), 'Library', 'LaunchAgents'), nodeBin = process.execPath, uid = process.getuid(), config = loadConfig(), run = args => spawnSync('/bin/launchctl', args, { encoding: 'utf8' }) } = {}) {
  const target = `gui/${uid}/${LABEL}`, plist = path.join(agentsDir, `${LABEL}.plist`);
  if (uninstall) {
    // A missing job is already uninstalled; fail for other launchctl errors.
    if (run(['print', target]).status === 0) check(run(['bootout', target]));
    if (existsSync(plist)) unlinkSync(plist);
    return plist;
  }
  if (!config?.hubUrl || !config?.token || !config?.source) throw new Error('Install the Deskling collector first.');
  if (config.codexBin && !existsSync(config.codexBin)) throw new Error('Configured codexBin does not exist; update ~/.deskling/config.json.');
  const bin = path.join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const source = path.dirname(fileURLToPath(import.meta.url));
  if (run(['print', target]).status === 0) check(run(['bootout', target]));
  for (const script of scripts) copyFileSync(path.join(source, script), path.join(bin, script));
  writeFileSync(plist, servicePlist(home, nodeBin), { mode: 0o600 });
  check(run(['bootstrap', `gui/${uid}`, plist]));
  return plist;
}

function check(result) {
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || 'launchctl failed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') throw new Error('This service installer supports macOS; use your system service manager on other platforms.');
  const uninstall = process.argv.includes('--uninstall');
  const plist = manageService({ uninstall });
  console.log(uninstall ? 'Deskling Codex background service removed.' : `Deskling Codex background service started; starts automatically at login.\nService: ${plist}\nLogs: ${path.join(HOME, 'logs')}`);
}
