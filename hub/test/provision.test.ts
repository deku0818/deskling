import test from 'node:test';
import assert from 'node:assert/strict';
import { hubAddress, provisionPlan } from '../src/provision.ts';
const info = { stage: 'idle', configured: true, protocol: 2, ssid: 'Home', hubType: 'local' as const, hub: 'http://192.168.1.8:8787' };
const wifi = { ssid: 'Home', password: '', preservePassword: true };
const addresses = ['http://192.168.1.8:8787'];

test('remote pairing never issues or forwards local credentials and discovery addresses', () => {
  const plan = provisionPlan({ ...wifi, hubType: 'remote', hub: 'https://hub.example.com/' }, info, addresses);
  assert.equal(plan.localCredential, false);
  assert.deepEqual(plan.values, { ...wifi, hubType: 'remote', hub: 'https://hub.example.com', hubId: '', token: '', pair: true });
});
test('remote manual token is sent only to the selected explicit target', () => {
  const plan = provisionPlan({ ...wifi, hubType: 'remote', hub: 'http://203.0.113.10:8787', useToken: true, token: 'remote-display' }, info, addresses);
  assert.equal(plan.localCredential, false); assert.equal(plan.values.token, 'remote-display'); assert.equal(plan.values.pair, false);
  assert.equal('hubs' in plan.values, false);
});
test('Wi-Fi-only edits preserve the device Hub without issuing a replacement credential', () => {
  const plan = provisionPlan({ ...wifi, keepHub: true, hubType: 'remote', hub: 'http://other.example', token: 'do-not-forward' }, info, addresses);
  assert.equal(plan.localCredential, false); assert.deepEqual(plan.values, { ...wifi, keepHub: true });
});
test('Hub-only edits use saved Wi-Fi and preserve its secret on the device', () => {
  const plan = provisionPlan({ ssid: 'ignored', password: 'ignored-password', keepWifi: true, hubType: 'remote', hub: 'http://203.0.113.10:8787' }, info, addresses);
  assert.equal(plan.values.ssid, 'Home'); assert.equal(plan.values.password, ''); assert.equal(plan.values.preservePassword, true);
});
test('local provisioning remains restricted to the host addresses', () => {
  assert.equal(provisionPlan(wifi, info, addresses).localCredential, true);
  assert.throws(() => provisionPlan({ ...wifi, hub: 'http://203.0.113.10:8787' }, info, addresses));
  assert.throws(() => provisionPlan(wifi, info, []));
});
test('invalid targets, header injection, empty tokens and unsupported firmware fail before provisioning', () => {
  for (const value of ['ws://example.com/ws', 'http://example.com/ws', 'http://user:pass@example.com', 'https://example.com?token=secret', 'http://example.com/#x', 'http://example.com\r\nHeader:secret']) assert.throws(() => hubAddress(value));
  assert.equal(hubAddress('https://example.com/'), 'https://example.com');
  assert.equal(hubAddress('http://[2001:db8::1]:8787'), 'http://[2001:db8::1]:8787');
  assert.throws(() => provisionPlan({ ...wifi, hubType: 'remote', hub: addresses[0] }, { ...info, protocol: 1 }, addresses));
  assert.throws(() => provisionPlan({ ...wifi, hubType: 'remote', hub: addresses[0], useToken: true }, info, addresses));
  assert.throws(() => provisionPlan({ ...wifi, hubType: 'remote', hub: addresses[0], useToken: true, token: 'bad\r\nHeader' }, info, addresses));
  assert.throws(() => provisionPlan({ ...wifi, ssid: '中文'.repeat(6) }, info, addresses));
  assert.throws(() => provisionPlan({ ...wifi, ssid: 'new-network' }, info, addresses));
});
