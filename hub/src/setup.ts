import type { IncomingMessage, ServerResponse } from 'node:http';
import { networkInterfaces, hostname } from 'node:os';
import { PairingStore } from './pairing.ts';
import { UsbDevice, usbPorts, type DeviceStatus } from './usb.ts';
import { provisionPlan } from './provision.ts';

export function localManagement(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')) return false;
  const host = req.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`) return false;
  if (req.method !== 'GET' && !req.headers['content-type']?.startsWith('application/json')) return false;
  return true;
}

export function lanAddresses(port: number): string[] {
  const entries = Object.entries(networkInterfaces()).sort(([a], [b]) => Number(b === 'en0') - Number(a === 'en0'));
  return entries.flatMap(([, values]) => (values ?? []).filter(v => v.family === 'IPv4' && !v.internal && !v.address.startsWith('169.254.')).map(v => `http://${v.address}:${port}`)).slice(0, 4);
}

const reply = (res: ServerResponse, code: number, data: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let count = 0;
  for await (const chunk of req) { count += chunk.length; if (count > 4096) throw new Error('配置数据过长。'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const text = (value: unknown, maximum = 256): string => { if (typeof value !== 'string' || value.length > maximum) throw new Error('配置格式不正确。'); return value; };

export class SetupService {
  private usb: UsbDevice | null = null;
  private deviceInfo: DeviceStatus | null = null;
  private credential: string | null = null;
  private provisionJob: number | null = null;
  private opening = false;
  private configuring = false;
  private polling = false;
  private monitor: ReturnType<typeof setInterval>;
  private port: number;
  readonly pairing: PairingStore;
  readonly name = `Deskling Hub (${hostname().replace(/\.local$/, '')})`;
  constructor(dataDir: string, port: number) {
    this.pairing = new PairingStore(dataDir); this.port = port;
    this.monitor = setInterval(() => { if (this.provisionJob !== null && !this.polling) void this.status().catch(() => {}); }, 1000);
    this.monitor.unref();
  }
  setPort(port: number) { this.port = port; }
  close() { clearInterval(this.monitor); this.usb?.close(); }
  private requireUsb() { if (!this.usb) throw new Error('请先连接 USB 设备。'); return this.usb; }
  private async status() {
    if (this.polling) return this.deviceInfo;
    this.polling = true;
    try {
      const status: DeviceStatus = await this.requireUsb().command('info', {}, 2500);
      this.deviceInfo = status;
      if (status.job === this.provisionJob && !status.busy && ['done', 'error', 'cancelled'].includes(status.stage)) {
        if (this.credential) {
          if (status.stage === 'done') this.pairing.activate(this.credential); else this.pairing.revoke(this.credential);
        }
        this.credential = null; this.provisionJob = null;
      }
      return status;
    } finally { this.polling = false; }
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/manage/') && !url.pathname.startsWith('/pair/')) return false;
    const management = url.pathname.startsWith('/manage/');
    if (management && !localManagement(req)) { reply(res, 403, { error: '请在运行 Hub 的电脑上打开 http://127.0.0.1:' + this.port + '/setup.html' }); return true; }
    try {
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /manage/info': reply(res, 200, { name: this.name, addresses: lanAddresses(this.port), devices: this.pairing.list(), pending: this.pairing.pending(), pairingOpen: this.pairing.open, pairingExpiresAt: this.pairing.expiresAt }); break;
        case 'GET /manage/usb/ports': reply(res, 200, { ports: await usbPorts() }); break;
        case 'POST /manage/usb/open': {
          if (this.opening || this.configuring || this.provisionJob !== null) throw new Error('设备正在配置，请稍后重试。');
          const input = await body(req); const devicePath = text(input.path, 256);
          if (!(await usbPorts()).some(p => p.path === devicePath)) throw new Error('没有找到连接的 Deskling。');
          this.opening = true;
          try {
            this.usb?.close(); this.usb = new UsbDevice(devicePath);
            this.deviceInfo = await this.usb.open(); reply(res, 200, this.deviceInfo);
          } catch (error) { this.usb?.close(); this.usb = null; throw error; }
          finally { this.opening = false; }
          break;
        }
        case 'GET /manage/usb/status': reply(res, 200, await this.status()); break;
        case 'POST /manage/usb/scan': reply(res, 200, await this.requireUsb().command('scan')); break;
        case 'POST /manage/usb/configure': {
          if (this.configuring || this.provisionJob !== null) throw new Error('设备正在配置，请稍后重试。');
          const input = await body(req);
          if (this.configuring || this.provisionJob !== null) throw new Error('设备正在配置，请稍后重试。');
          this.configuring = true;
          let credential: ReturnType<PairingStore['issue']> | null = null;
          try {
            const info: DeviceStatus = await this.requireUsb().command('info');
            if (info.busy) throw Error('设备正在配置，请稍后重试。');
            const plan = provisionPlan(input, info, lanAddresses(this.port));
            const values: any = plan.values;
            if (plan.localCredential) {
              credential = this.pairing.issue(info.deviceId ?? '', 'Deskling');
              values.token = credential.token; values.hubId = this.pairing.hubId;
            }
            let result;
            try { result = await this.requireUsb().command('configure', values); }
            catch (error) {
              // A missing acknowledgement can occur after the device accepted the job.
              // Resume that job only when its destination matches the submitted configuration.
              const observed: DeviceStatus | null = await this.requireUsb().command('info', {}, 2500).catch(() => null);
              const targetType = values.hubType ?? info.hubType;
              const targetHub = values.keepHub ? info.hub : values.hub;
              if (!observed || observed.job !== (info.job ?? 0) + 1 || observed.ssid !== values.ssid ||
                  observed.targetHubType !== targetType || (targetHub && observed.targetHub !== targetHub)) throw error;
              result = { job: observed.job };
            }
            this.credential = credential?.id ?? null; this.provisionJob = result.job; reply(res, 202, result);
          } catch (error) {
            // A lost USB acknowledgement does not prove that the device rejected the settings.
            // Keep the five-minute lease so a successful device can still activate its credential.
            throw error;
          }
          finally { this.configuring = false; }
          break;
        }
        case 'POST /manage/usb/cancel': reply(res, 200, await this.requireUsb().command('cancel')); break;
        case 'POST /manage/usb/provider': {
          const input = await body(req); if (!['claude', 'codex'].includes(input.provider)) throw new Error('选择无效。');
          reply(res, 200, await this.requireUsb().command('provider', { provider: input.provider })); break;
        }
        case 'POST /manage/usb/close': if (this.provisionJob !== null || this.configuring) throw new Error('请等待配置结束。'); this.usb?.close(); this.usb = null; reply(res, 200, { ok: true }); break;
        case 'POST /manage/pairing/start': await body(req); reply(res, 200, this.pairing.begin()); break;
        case 'POST /manage/pairing/approve': { const input = await body(req); this.pairing.approve(text(input.id, 32)); reply(res, 200, { ok: true }); break; }
        case 'POST /manage/pairing/reject': { const input = await body(req); this.pairing.reject(text(input.id, 32)); reply(res, 200, { ok: true }); break; }
        case 'GET /pair/info': reply(res, 200, { name: this.name, hubId: this.pairing.hubId, pairingOpen: this.pairing.open }); break;
        case 'POST /pair/request': { const input = await body(req); reply(res, 200, { ...this.pairing.request(text(input.deviceId, 64), text(input.name, 64)), hubId: this.pairing.hubId, name: this.name }); break; }
        case 'GET /pair/status': {
          const secret = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
          const status = this.pairing.status(url.searchParams.get('id') ?? '', secret);
          reply(res, status ? 200 : 404, status ?? { error: '配对已过期。' }); break;
        }
        case 'POST /pair/complete': { const input = await body(req); this.pairing.complete(text(input.id, 32), req.headers.authorization?.replace(/^Bearer /, '') ?? ''); reply(res, 200, { ok: true }); break; }
        case 'POST /pair/activate': { await body(req); this.pairing.activateToken(req.headers.authorization?.replace(/^Bearer /, '') ?? ''); reply(res, 200, { ok: true }); break; }
        default: reply(res, 404, { error: 'not found' });
      }
    } catch (error) { reply(res, 400, { error: error instanceof Error ? error.message : '配置失败。' }); }
    return true;
  }
}
