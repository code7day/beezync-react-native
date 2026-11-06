import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BeezyncClient } from '../src/client';
import type { BeezyncMessage } from '../src/types';

const env = process.env;
const enabled = Boolean(env.BEEZYNC_BASE_URL && env.BEEZYNC_APP_ID && env.BEEZYNC_PUBLIC_KEY && env.BEEZYNC_SECRET_KEY);

async function secretCall(method: string, path: string, body?: unknown) {
  const res = await fetch(env.BEEZYNC_BASE_URL + path, {
    method,
    headers: { Authorization: `Bearer ${env.BEEZYNC_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

function waitFor(messages: BeezyncMessage[], pred: (m: BeezyncMessage) => boolean, ms = 5000): Promise<BeezyncMessage> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const m = messages.find(pred);
      if (m) {
        clearInterval(timer);
        resolve(m);
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error('timeout waiting for message'));
      }
    }, 25);
  });
}

test('live engine flow', { skip: !enabled && 'set BEEZYNC_BASE_URL, BEEZYNC_APP_ID, BEEZYNC_PUBLIC_KEY, BEEZYNC_SECRET_KEY' }, async () => {
  const client = new BeezyncClient({ appId: env.BEEZYNC_APP_ID!, publicKey: env.BEEZYNC_PUBLIC_KEY!, baseUrl: env.BEEZYNC_BASE_URL! });
  const suffix = randomUUID().slice(0, 8);
  const userId = `sdk-it-${suffix}`;
  const channel = `sdk-it-${suffix}`;
  const messages: BeezyncMessage[] = [];
  const subscribed: string[] = [];
  client.on('message', (m) => messages.push(m));
  client.on('subscribed', (c) => subscribed.push(c));

  try {
    const reg = await client.registerDevice({ token: `it-token-${suffix}`, platform: 'android', externalUserId: userId, tags: { suite: 'integration' } });
    assert.ok(reg.ok, `register failed: ${reg.status} ${reg.error}`);
    assert.ok((await client.setTags({ step: 'two' })).ok);

    const opened = new Promise<void>((r) => client.on('open', () => r()));
    client.connect();
    await opened;
    client.subscribe(channel);
    for (let i = 0; i < 200 && !subscribed.includes(channel); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(subscribed.includes(channel), 'subscription not confirmed');

    const pub = await secretCall('POST', '/v1/api/publish', { channel, event: 'it-event', data: { hello: suffix } });
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    const got = (await waitFor(messages, (m) => m.kind === 'event' && m.event === 'it-event')) as any;
    assert.equal(got.channel, channel);
    assert.deepEqual(got.data, { hello: suffix });

    const push = await secretCall('POST', '/v1/api/send-push', {
      title: 'SDK test',
      body: suffix,
      target_type: 'channel',
      target_value: channel,
      transport: 'ws',
      data: { k: 'v' },
    });
    assert.equal(push.status, 202, JSON.stringify(push.json));
    const id: string = push.json.id;
    const note = (await waitFor(messages, (m) => m.kind === 'notification' && m.id === id)) as any;
    assert.equal(note.title, 'SDK test');
    assert.equal(note.body, suffix);

    assert.ok((await client.trackReceived(id)).ok);
    assert.ok((await client.trackClicked(id)).ok);
    assert.ok((await client.trackClicked(id)).ok);

    let counters: any;
    for (let i = 0; i < 20; i++) {
      counters = (await secretCall('GET', `/v1/api/notifications/${id}`)).json;
      if (counters.received >= 1 && counters.clicked >= 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(counters.received, 1);
    assert.equal(counters.clicked, 1);
    assert.equal(counters.dismissed, 0);

    assert.ok((await client.unregisterDevice()).ok);
  } finally {
    client.disconnect();
  }
});
