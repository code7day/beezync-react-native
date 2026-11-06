import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffDelay } from '../src/backoff';
import { getBeezyncId } from '../src/firebase';
import { parseFrame } from '../src/frames';
import { setup } from './helpers';

test('parseFrame handles system, published and notification frames', () => {
  assert.deepEqual(parseFrame('{"event":"connection_established","data":{"socket_id":"abc"}}'), { type: 'connection_established', socketId: 'abc' });
  assert.deepEqual(parseFrame('{"event":"connection_established","data":"{\\"socket_id\\":\\"x\\"}"}'), { type: 'connection_established', socketId: 'x' });
  assert.deepEqual(parseFrame('{"event":"subscription_succeeded","channel":"c"}'), { type: 'subscription_succeeded', channel: 'c' });
  assert.deepEqual(parseFrame('{"event":"subscription_error","channel":"c","error":"nope"}'), { type: 'subscription_error', channel: 'c', error: 'nope' });
  assert.deepEqual(parseFrame('{"event":"pong"}'), { type: 'pong' });
  const pub = parseFrame('{"event":"news","channel":"c","data":{"a":1},"id":"i","ts":5}');
  assert.deepEqual(pub, { type: 'message', message: { kind: 'event', event: 'news', channel: 'c', data: { a: 1 }, id: 'i', ts: 5 } });
  const n = parseFrame('{"id":"n1","title":"T","body":"B","data":{"k":"v"}}');
  assert.deepEqual(n, { type: 'message', message: { kind: 'notification', id: 'n1', title: 'T', body: 'B', channel: undefined, data: { k: 'v' } } });
  assert.equal(parseFrame('garbage'), null);
  assert.equal(parseFrame('[]'), null);
  assert.equal(parseFrame('{"foo":1}'), null);
});

test('backoffDelay grows from 1s and caps at 30s with jitter', () => {
  const mid = () => 0.5;
  assert.equal(backoffDelay(0, 1000, 30000, mid), 1000);
  assert.equal(backoffDelay(1, 1000, 30000, mid), 2000);
  assert.equal(backoffDelay(3, 1000, 30000, mid), 8000);
  assert.equal(backoffDelay(10, 1000, 30000, mid), 30000);
  for (let a = 0; a < 12; a++) {
    for (const r of [0, 0.5, 0.999]) {
      const d = backoffDelay(a, 1000, 30000, () => r);
      assert.ok(d >= 1000 && d <= 30000);
    }
  }
  assert.ok(backoffDelay(3, 1000, 30000, () => 0) < backoffDelay(3, 1000, 30000, () => 0.99));
});

test('getBeezyncId reads bz_id from remote message data', () => {
  assert.equal(getBeezyncId({ data: { bz_id: 'abc' } }), 'abc');
  assert.equal(getBeezyncId({ bz_id: 'abc' }), 'abc');
  assert.equal(getBeezyncId({ data: {} }), undefined);
  assert.equal(getBeezyncId({ data: { bz_id: 5 } }), undefined);
  assert.equal(getBeezyncId(null), undefined);
});

test('registerDevice, setUser, setTags, unregister send the right requests', async () => {
  const { client, calls } = setup();
  const r = await client.registerDevice({ token: 'tok', platform: 'ios', externalUserId: 'u1', tags: { plan: 'pro' } });
  assert.ok(r.ok);
  assert.equal(calls[0].url, 'https://api.example.com/v1/api/register-device');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers?.Authorization, 'Bearer pk_test');
  assert.deepEqual(calls[0].body, { token: 'tok', platform: 'ios', external_user_id: 'u1', tags: { plan: 'pro' } });
  await client.setUser('u2');
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, 'https://api.example.com/v1/api/devices');
  assert.deepEqual(calls[1].body, { token: 'tok', external_user_id: 'u2' });
  await client.setTags({ a: 1 });
  assert.deepEqual(calls[2].body, { token: 'tok', tags: { a: 1 } });
  await client.unregisterDevice();
  assert.equal(calls[3].url, 'https://api.example.com/v1/api/unregister-device');
  assert.deepEqual(calls[3].body, { token: 'tok' });
  assert.equal((await client.setTags({})).code, 'no_token');
});

test('tracking posts notification-events with the device token', async () => {
  const { client, calls } = setup();
  await client.registerDevice({ token: 'tok', platform: 'android' });
  await client.trackReceived('n1');
  await client.trackClicked('n1');
  await client.trackDismissed('n1');
  assert.deepEqual(calls.slice(1).map((c) => c.body), [
    { notification_id: 'n1', event: 'received', token: 'tok' },
    { notification_id: 'n1', event: 'clicked', token: 'tok' },
    { notification_id: 'n1', event: 'dismissed', token: 'tok' },
  ]);
  assert.equal(calls[1].url, 'https://api.example.com/v1/api/notification-events');
  assert.equal((await client.trackReceived('')).code, 'no_id');
});

test('HTTP errors and network failures are returned, not thrown', async () => {
  const bad = setup({}, () => ({ status: 401, body: { error: 'bad key', code: 'invalid_key' } }));
  const r = await bad.client.registerDevice({ token: 't', platform: 'ios' });
  assert.deepEqual([r.ok, r.status, r.error, r.code], [false, 401, 'bad key', 'invalid_key']);
  const down = setup({
    fetch: async () => {
      throw new Error('offline');
    },
  });
  const r2 = await down.client.trackClicked('x');
  assert.deepEqual([r2.ok, r2.status, r2.error], [false, 0, 'offline']);
});

test('connect builds the ws url, emits open, subscribes and delivers messages', () => {
  const { client, sockets } = setup();
  const seen: any[] = [];
  client.on('open', (i) => seen.push(['open', i.socketId]));
  client.on('message', (m) => seen.push(['message', m]));
  client.on('subscribed', (c) => seen.push(['subscribed', c]));
  client.subscribe('news');
  client.connect();
  client.connect();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'wss://api.example.com/v1/ws?app_id=app-1&key=pk_test');
  assert.equal(client.connected, false);
  sockets[0].established('sid');
  assert.equal(client.connected, true);
  assert.deepEqual(sockets[0].sent, [{ action: 'subscribe', channel: 'news' }]);
  sockets[0].serverSend({ event: 'subscription_succeeded', channel: 'news' });
  sockets[0].serverSend({ event: 'hello', channel: 'news', data: { x: 1 }, id: 'm1', ts: 1 });
  sockets[0].serverSend({ id: 'n1', title: 'T', body: 'B' });
  assert.equal(seen[0][1], 'sid');
  assert.equal(seen[1][1], 'news');
  assert.equal(seen[2][1].kind, 'event');
  assert.equal(seen[3][1].kind, 'notification');
  client.disconnect();
});

test('private channel auth and token are sent; authorize callback receives socket id', async () => {
  const { client, sockets } = setup();
  client.connect();
  sockets[0].established('sid');
  client.subscribe('private-a', 'hex123');
  client.subscribe('private-b', { token: 'tk' });
  client.subscribe('private-c', { authorize: async (sid, ch) => ({ auth: `${sid}:${ch}` }) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sockets[0].sent, [
    { action: 'subscribe', channel: 'private-a', auth: 'hex123' },
    { action: 'subscribe', channel: 'private-b', token: 'tk' },
    { action: 'subscribe', channel: 'private-c', auth: 'sid:private-c' },
  ]);
  client.unsubscribe('private-a');
  assert.deepEqual(sockets[0].sent.at(-1), { action: 'unsubscribe', channel: 'private-a' });
  client.disconnect();
});

test('reconnect uses backoff, re-subscribes and resets after success', () => {
  const { client, sockets, fire } = setup();
  const closes: any[] = [];
  client.on('close', (c) => closes.push(c));
  client.subscribe('a');
  client.subscribe('b');
  client.connect();
  sockets[0].established();
  sockets[0].serverClose(1006);
  assert.equal(closes[0].willReconnect, true);
  assert.equal(client.connected, false);
  assert.equal(fire(), 1000);
  assert.equal(sockets.length, 2);
  sockets[1].serverClose(1006);
  assert.equal(fire(), 2000);
  sockets[2].serverClose(1006);
  assert.equal(fire(), 4000);
  sockets[3].established();
  assert.deepEqual(sockets[3].sent.map((f) => f.channel), ['a', 'b']);
  sockets[3].serverClose(1006);
  assert.equal(fire(), 1000);
  client.disconnect();
});

test('close code 4200 reconnects immediately', () => {
  const { client, sockets, fire } = setup();
  client.connect();
  sockets[0].established();
  sockets[0].serverClose(4200);
  assert.equal(fire(), 0);
  assert.equal(sockets.length, 2);
  client.disconnect();
});

test('disconnect stops reconnecting and ignores stale sockets', () => {
  const { client, sockets, timers } = setup();
  client.connect();
  sockets[0].established();
  client.disconnect();
  assert.equal(sockets[0].closed, true);
  sockets[0].serverClose(1006);
  assert.equal(timers.filter((t) => t.live).length, 0);
  assert.equal(client.connected, false);
});

test('ping is sent on the configured interval', () => {
  const { client, sockets, fire } = setup({ pingIntervalMs: 25000 });
  client.connect();
  sockets[0].established();
  assert.equal(fire(), 25000);
  assert.deepEqual(sockets[0].sent.at(-1), { action: 'ping' });
  client.disconnect();
});
