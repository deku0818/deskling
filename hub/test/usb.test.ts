import test from 'node:test';
import assert from 'node:assert/strict';
import { SerialFrames, UsbDevice } from '../src/usb.ts';

test('USB frames preserve Chinese text even when serial chunks split every UTF-8 character', () => {
  const parser = new SerialFrames();
  const frame = { id: 'test', ok: true, data: { error: '没有找到 Wi-Fi，请重新选择网络。', ssid: '我的网络' } };
  const bytes = Buffer.from('boot log\n@deskling ' + JSON.stringify(frame) + '\n');
  const frames = [...bytes].flatMap(byte => parser.append(Buffer.from([byte])));
  assert.deepEqual(frames, [frame]);
  assert.deepEqual(parser.append(Buffer.from('@deskling not-json\nnoise\n@deskling {"id":"next","ok":true}\n')), [{ id: 'next', ok: true }]);
  assert.deepEqual(parser.append(Buffer.from('@deskling null\n@deskling []\n@deskling {"ok":true}\n')), []);
});


test('USB status recovers a dropped reply without retrying configuration writes', async () => {
  const device = new UsbDevice('/test-only-unopened-port');
  const internal = device as any; internal.connected = true;
  let reads = 0, writes = 0;
  internal.port = { write(frame: string) {
    const request = JSON.parse(frame.slice('@deskling '.length));
    if (request.op === 'info') {
      if (++reads === 1) return;
      internal.consume(Buffer.from('@deskling ' + JSON.stringify({ id:request.id, ok:true, data:{stage:'pair_wait',job:2,busy:true} }) + '\n'));
    } else writes++;
  }};
  try {
    assert.deepEqual(await device.command('info', {}, 10), {stage:'pair_wait',job:2,busy:true});
    assert.equal(reads, 2);
    await assert.rejects(device.command('configure', {hubType:'remote'}, 10), /超时/);
    assert.equal(writes, 1);
  } finally { device.close(); }
});
