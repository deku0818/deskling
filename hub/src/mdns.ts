// Advertises the hub on the local network as _deskling._tcp, so a display with no hub address
// configured can find it. Only useful on a LAN; turn it off (MDNS=0) behind a public domain.
//
// The responder answers under a host name of its own (deskling-<host>.local). Announcing the
// machine's own host name would collide with the system's mDNS responder, and macOS answers such
// a conflict by renaming the computer (e.g. to "name-2.local").
import { hostname } from 'node:os';
import { Bonjour } from 'bonjour-service';
import { SNAPSHOT_VERSION, WS_PATH } from './protocol.ts';

export function advertise(port: number, hubId?: string): () => void {
  const host = hostname().replace(/\.local$/, '');
  const name = `Deskling Hub (${host})`;
  const ownHost = `deskling-${host.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}.local`;
  const bonjour = new Bonjour();
  // TXT tells the display how to connect without guessing: protocol version and WebSocket path.
  const service = bonjour.publish({ name, type: 'deskling', port, host: ownHost, txt: { v: String(SNAPSHOT_VERSION), ws: WS_PATH, ...(hubId ? { id: hubId, pair: '1' } : {}) } });
  service.on('up', () => console.log(`mdns: advertising "${name}" as _deskling._tcp on ${ownHost}:${port}`));
  service.on('error', (error: Error) => console.warn('mdns: advertising failed:', error.message));
  return () => bonjour.destroy();
}
