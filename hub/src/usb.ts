import { SerialPort } from 'serialport';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const PREFIX = '@deskling ';
export class SerialFrames {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  append(chunk: Buffer): any[] {
    this.buffer += this.decoder.write(chunk);
    const frames: any[] = []; let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      const position = line.indexOf(PREFIX); if (position < 0) continue;
      try {
        const frame = JSON.parse(line.slice(position + PREFIX.length));
        if (frame && typeof frame === 'object' && typeof frame.id === 'string' && typeof frame.ok === 'boolean') frames.push(frame);
      } catch { /* Ignore boot logs and malformed frames. */ }
    }
    if (this.buffer.length > 32_768) this.buffer = this.buffer.slice(-4096);
    return frames;
  }
}
export type DeviceStatus = { stage: string; error?: string; detail?: string; ssid?: string; hub?: string; hubType?: 'local' | 'remote'; targetHub?: string; targetHubType?: string; code?: string; job?: number; busy?: boolean; connected?: boolean; configured?: boolean; deviceId?: string; provider?: string; ip?: string; hasPassword?: boolean; hubId?: string; protocol?: number };
type Pending = { resolve: (data: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class UsbDevice {
  private port: SerialPort;
  private frames = new SerialFrames();
  private pending = new Map<string, Pending>();
  private connected = false;
  constructor(devicePath: string) {
    this.port = new SerialPort({ path: devicePath, baudRate: 115200, autoOpen: false, lock: true });
    this.port.on('data', (chunk: Buffer) => this.consume(chunk));
    this.port.on('error', () => this.fail());
    this.port.on('close', () => this.fail());
  }
  private fail() {
    this.connected = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('USB 已断开，请重新连接设备。')); }
    this.pending.clear();
  }
  private consume(chunk: Buffer) {
    for (const frame of this.frames.append(chunk)) {
        const p = this.pending.get(frame.id);
        if (!p) continue;
        clearTimeout(p.timer); this.pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.data); else p.reject(new Error(frame.error || '设备请求失败。'));
    }
  }
  async open() {
    await new Promise<void>((resolve, reject) => this.port.open(e => e ? reject(new Error('无法打开 USB，请关闭串口监视器后重试。')) : resolve()));
    this.connected = true;
    await new Promise<void>((resolve, reject) => this.port.set({ dtr: false, rts: false }, e => e ? reject(e) : resolve()));
    // Opening a USB console can reset an ESP32-S3; probe until the application is ready.
    for (let attempt = 0; attempt < 10; attempt++) {
      try { return await this.command('info', {}, 1500); }
      catch { if (!this.connected) throw new Error('USB 已断开。'); }
    }
    throw new Error('设备没有响应配置协议，请先升级固件。');
  }
  async command(op: string, values: object = {}, timeout = 30_000): Promise<any> {
    // Reading status is idempotent. Retry missing frames, but never replay configuration writes.
    for (let attempt = 0; ; attempt++) {
      try { return await this.request(op, values, timeout); }
      catch (error) {
        if (op !== 'info' || attempt >= 2 || !this.connected || !(error instanceof Error) || error.message !== '设备响应超时，请重试。') throw error;
      }
    }
  }
  private request(op: string, values: object, timeout: number): Promise<any> {
    if (!this.connected) throw new Error('USB 未连接。');
    const id = randomBytes(6).toString('hex');
    const frame = PREFIX + JSON.stringify({ v: 1, id, op, ...values }) + '\n';
    if (Buffer.byteLength(frame) > 2048) throw new Error('配置数据过长。');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('设备响应超时，请重试。')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.port.write(frame, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('USB 写入失败。')); } });
    });
  }
  close() { this.fail(); if (this.port.isOpen) this.port.close(() => {}); }
}

export async function usbPorts() {
  const ports = await SerialPort.list();
  return ports.filter(p => p.vendorId?.toLowerCase() === '303a').map(p => ({ path: p.path, name: 'Deskling', serialNumber: p.serialNumber }));
}
