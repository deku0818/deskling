import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import path from 'node:path';

const TTL = 5 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Device = { id: string; deviceId: string; name: string; tokenHash: string; createdAt: number; expiresAt?: number };
type Request = { id: string; deviceId: string; name: string; code: string; secretHash: string; expiresAt: number; token?: string; approved: boolean };

export class PairingStore {
  private file: string;
  private devices: Device[] = [];
  private requests = new Map<string, Request>();
  private windowUntil = 0;
  readonly hubId: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'devices.json');
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof data.hubId !== 'string' || !/^[a-f0-9]{32}$/.test(data.hubId) || !Array.isArray(data.devices)) throw new Error('invalid device store');
      this.hubId = data.hubId;
      this.devices = data.devices.filter((d: Device) => typeof d.id === 'string' && /^[a-f0-9]{64}$/.test(d.tokenHash) && typeof d.createdAt === 'number');
      chmodSync(this.file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.hubId = randomBytes(16).toString('hex');
      this.save();
    }
  }
  private save() {
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify({ hubId: this.hubId, devices: this.devices }), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }
  private prune(now = Date.now()) {
    for (const [id, request] of this.requests) if (request.expiresAt <= now) this.requests.delete(id);
    const count = this.devices.length;
    this.devices = this.devices.filter(d => !d.expiresAt || d.expiresAt > now);
    if (count !== this.devices.length) this.save();
  }
  accepts(token: string | null): boolean {
    if (!token) return false;
    this.prune();
    const candidate = Buffer.from(hash(token), 'hex');
    return this.devices.some(d => timingSafeEqual(candidate, Buffer.from(d.tokenHash, 'hex')));
  }
  begin() { this.windowUntil = Date.now() + TTL; return { expiresAt: this.windowUntil }; }
  get open() { return this.windowUntil > Date.now(); }
  get expiresAt() { return this.windowUntil; }
  list() { this.prune(); return this.devices.filter(d => !d.expiresAt).map(({ tokenHash, ...d }) => d); }
  pending() { this.prune(); return [...this.requests.values()].filter(r => !r.approved).map(({ secretHash, token, ...r }) => r); }
  issue(deviceId: string, name: string) {
    this.prune();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(deviceId)) throw new Error('invalid device ID');
    const id = randomBytes(16).toString('hex'), token = randomBytes(24).toString('hex');
    this.devices.push({ id, deviceId, name: name.slice(0, 64), tokenHash: hash(token), createdAt: Date.now(), expiresAt: Date.now() + TTL });
    this.save();
    return { id, token };
  }
  activate(id: string) { const d = this.devices.find(d => d.id === id); if (!d || (d.expiresAt && d.expiresAt <= Date.now())) throw new Error('credential expired'); delete d.expiresAt; this.devices = this.devices.filter(other => other.id === id || other.deviceId !== d.deviceId); this.save(); }
  revoke(id: string) { this.devices = this.devices.filter(d => d.id !== id); this.save(); }
  activateToken(token: string) {
    this.prune(); const digest = hash(token); const device = this.devices.find(d => d.tokenHash === digest);
    if (!device) throw new Error('credential expired');
    if (device.expiresAt) this.activate(device.id);
    for (const [id, r] of this.requests) if (r.token === token) this.requests.delete(id);
  }
  request(deviceId: string, name: string) {
    this.prune();
    if (!this.open) throw new Error('pairing window closed');
    if (this.requests.size >= 16) throw new Error('too many pairing requests');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(deviceId) || !name || name.length > 64) throw new Error('invalid device');
    // Each attempt gets its own secret; a repeated device ID cannot replace another pending request.
    const id = randomBytes(16).toString('hex'), secret = randomBytes(24).toString('hex');
    let code: string;
    do { code = String(randomInt(100000, 1000000)); } while ([...this.requests.values()].some(r => r.code === code));
    const request: Request = { id, deviceId, name, code, secretHash: hash(secret), expiresAt: Math.min(this.windowUntil, Date.now() + TTL), approved: false };
    this.requests.set(id, request);
    return { id, secret, code, expiresAt: request.expiresAt };
  }
  approve(id: string) {
    this.prune(); const r = this.requests.get(id);
    if (!r) throw new Error('pairing request expired');
    if (!r.approved) { const credential = this.issue(r.deviceId, r.name); r.token = credential.token; r.approved = true; }
  }
  reject(id: string) {
    this.prune(); const r = this.requests.get(id);
    if (!r || r.approved) throw new Error('pairing request expired or already approved');
    this.requests.delete(id);
  }
  status(id: string, secret: string) {
    this.prune(); const r = this.requests.get(id);
    if (!r || hash(secret) !== r.secretHash) return null;
    return { approved: r.approved, token: r.token, expiresAt: r.expiresAt, hubId: this.hubId };
  }
  complete(id: string, secret: string) {
    const status = this.status(id, secret);
    if (!status?.token) throw new Error('pairing not approved');
    const tokenHash = hash(status.token);
    const d = this.devices.find(d => d.tokenHash === tokenHash);
    if (!d) throw new Error('credential expired');
    this.activate(d.id); this.requests.delete(id);
  }
}
