import { BeezyncClient } from '../src/client';
import type { BeezyncConfig, SocketLike } from '../src/types';

export class FakeSocket implements SocketLike {
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  sent: any[] = [];
  closed = false;
  constructor(public url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
  }
  serverSend(obj: unknown) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  established(id = 's1') {
    this.serverSend({ event: 'connection_established', data: { socket_id: id } });
  }
  serverClose(code: number) {
    this.onclose?.({ code, reason: '' });
  }
}

export interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}

export function setup(extra: Partial<BeezyncConfig> = {}, reply: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const sockets: FakeSocket[] = [];
  const calls: Call[] = [];
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  const client = new BeezyncClient({
    appId: 'app-1',
    publicKey: 'pk_test',
    baseUrl: 'https://api.example.com/',
    random: () => 0.5,
    pingIntervalMs: 0,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    fetch: async (url, init) => {
      const call: Call = { url, method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const r = reply(call);
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
    },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, id: timers.length, live: true };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (id) => {
      const t = timers[id as number];
      if (t) t.live = false;
    },
    ...extra,
  });
  const fire = () => {
    const t = timers.filter((x) => x.live).pop();
    if (!t) throw new Error('no live timer');
    t.live = false;
    t.fn();
    return t.ms;
  };
  return { client, sockets, calls, timers, fire };
}
