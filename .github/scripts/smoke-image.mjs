// Exercise the packaged Hub on both architectures, including serialport's Linux tools.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
if (!image) throw new Error('Usage: node .github/scripts/smoke-image.mjs IMAGE');
const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
});
// Classic Docker stores cannot retain two variants under the same index digest.
// Resolve each registry manifest so both variants can be tested on those runners.
const published = image.includes('@sha256:');
const index = published ? JSON.parse(docker('buildx', 'imagetools', 'inspect', '--raw', image)) : null;
function platformImage(platform) {
  if (!published) return image;
  const [os, architecture] = platform.split('/');
  const manifest = index.manifests?.find(item =>
    item.platform?.os === os && item.platform?.architecture === architecture);
  if (!manifest) throw new Error('Missing published platform: ' + platform);
  return image.split('@')[0] + '@' + manifest.digest;
}
const probe = `
import fs from 'node:fs';
if (process.arch !== process.env.EXPECTED_ARCH) throw new Error('Unexpected architecture: ' + process.arch);
const base = 'http://127.0.0.1:8787';
for (const route of ['/healthz', '/', '/setup.html', '/assets/pets/clawd/pet.js', '/assets/fonts/deck-pixel.woff2', '/manage/usb/ports']) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(route + ': ' + response.status + ' ' + await response.text());
  if (route === '/' && !(await response.text()).includes('round-adapted')) throw new Error('Missing round-screen UI');
}
for (const provider of ['claude', 'codex']) {
  const response = await fetch(base + '/snapshot?provider=' + provider, { headers: { authorization: 'Bearer smoke-display' } });
  const data = await response.json();
  if (!response.ok || data.v !== 2 || data.provider !== provider) throw new Error('Invalid snapshot: ' + provider);
}
for (const file of ['/app/LICENSE', '/app/NOTICE']) if (!fs.existsSync(file)) throw new Error('Missing ' + file);
`;

for (const [platform, arch] of [['linux/amd64', 'x64'], ['linux/arm64', 'arm64']]) {
  const name = 'deskling-smoke-' + randomUUID();
  let started = false;
  try {
    const target = platformImage(platform);
    docker('run', '--detach', '--rm', '--network', 'none', '--platform', platform,
      ...(published ? ['--pull=always'] : []), '--name', name,
      '-e', 'INGEST_TOKEN=smoke-ingest', '-e', 'DISPLAY_TOKEN=smoke-display',
      '-e', 'EXPECTED_ARCH=' + arch, target);
    started = true;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        docker('exec', name, 'node', '--input-type=module', '-e', probe);
        break;
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new Error(platform + ': ' + String(error.stderr ?? error.message));
        }
        await delay(500);
      }
    }
    console.log(platform + ': health, pages, assets, both providers, USB enumeration and notices passed');
  } finally {
    if (started) docker('rm', '--force', '--volumes', name);
  }
}
