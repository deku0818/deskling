import type { DeviceStatus } from './usb.ts';

export function hubAddress(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 255) throw Error('Hub 地址过长或格式不正确。');
  if (!value) return '';
  if (/\s/.test(value)) throw Error('Hub 地址不能包含空格。');
  let url: URL;
  try { url = new URL(value); } catch { throw Error('填写 http:// 或 https:// Hub 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('填写 http:// 或 https:// 地址，不需要 /ws。');
  return url.origin;
}

export function provisionPlan(input: any, info: DeviceStatus, addresses: string[]) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('配置格式不正确。');
  const keepWifi = input.keepWifi === true, keepHub = input.keepHub === true;
  const ssid = keepWifi ? info.ssid : input.ssid;
  const password = keepWifi ? '' : input.password;
  if (typeof ssid !== 'string' || !ssid || Buffer.byteLength(ssid) > 32 || typeof password !== 'string' || Buffer.byteLength(password) > 64 || (password && !/^(?:[\s\S]{8,63}|[a-fA-F0-9]{64})$/.test(password))) throw Error('检查 Wi-Fi 名称和密码。');
  if ((keepWifi || keepHub) && !info.configured) throw Error('设备还没有已保存的配置。');
  const preservePassword = keepWifi || input.preservePassword === true;
  if (preservePassword && !password && ssid !== info.ssid) throw Error('更换 Wi-Fi 时需要输入新密码。');
  if (keepHub) return { localCredential: false, values: { ssid, password, preservePassword, keepHub: true } };
  const hubType = input.hubType ?? 'local';
  if (!['local', 'remote'].includes(hubType)) throw Error('请选择本机 Hub 或远程 Hub。');
  const hub = hubAddress(input.hub ?? '');
  if (hubType === 'local') {
    if (hub && !addresses.includes(hub)) throw Error('本机 Hub 请选择这台电脑的地址；其他服务器请选择远程 Hub。');
    if (!addresses.length) throw Error('这台电脑尚未连接局域网。');
    return { localCredential: true, values: { ssid, password, preservePassword, hubType, hub, hubs: addresses, pair: false } };
  }
  if ((info.protocol ?? 1) < 2) throw Error('请先升级设备固件，再配置远程 Hub。');
  if (!hub) throw Error('请输入远程 Hub 地址。');
  const manual = input.useToken === true;
  const token = input.token ?? '';
  if (typeof token !== 'string' || token.length > 256 || (token && !/^[!-~]+$/.test(token))) throw Error('Token 格式不正确。');
  if (manual && !token) throw Error('请填写远程 Hub 的显示 Token。');
  return { localCredential: false, values: { ssid, password, preservePassword, hubType, hub, hubId: '', token: manual ? token : '', pair: !manual } };
}
