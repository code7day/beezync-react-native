import { backoffDelay } from './backoff';
import { parseFrame } from './frames';
import type {
  BeezyncConfig,
  BeezyncEvents,
  BeezyncMessage,
  FetchLike,
  RegisterDeviceInput,
  Result,
  SocketFactory,
  SocketLike,
  SubscribeAuth,
  Tags,
  TrackEvent,
} from './types';

type Handlers = { [K in keyof BeezyncEvents]: Set<BeezyncEvents[K]> };

export const RECONNECT_NOW_CODE = 4200;

export class BeezyncClient {
  private readonly appId: string;
  private readonly publicKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly createSocket: SocketFactory;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly random: () => number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;
  private readonly pingInterval: number;

  private deviceToken?: string;
  private externalUserId?: string;
  private socket?: SocketLike;
  private socketId = '';
  private wantConnected = false;
  private attempt = 0;
  private reconnectTimer: unknown;
  private pingTimer: unknown;
  private readonly channels = new Map<string, SubscribeAuth | undefined>();
  private readonly handlers: Handlers = {
    message: new Set(),
    open: new Set(),
    close: new Set(),
    subscribed: new Set(),
    subscription_error: new Set(),
  };

  constructor(config: BeezyncConfig) {
    this.appId = config.appId;
    this.publicKey = config.publicKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    const g = globalThis as any;
    this.fetchFn = config.fetch ?? ((u, i) => g.fetch(u, i));
    this.createSocket = config.createSocket ?? ((url) => new g.WebSocket(url) as SocketLike);
    this.setTimer = config.setTimeout ?? ((fn, ms) => g.setTimeout(fn, ms));
    this.clearTimer = config.clearTimeout ?? ((h) => g.clearTimeout(h));
    this.random = config.random ?? Math.random;
    this.minBackoff = config.minBackoffMs ?? 1000;
    this.maxBackoff = config.maxBackoffMs ?? 30000;
    this.pingInterval = config.pingIntervalMs ?? 25000;
  }

  get connected(): boolean {
    return this.socketId !== '';
  }

  get currentSocketId(): string {
    return this.socketId;
  }

  on<K extends keyof BeezyncEvents>(event: K, handler: BeezyncEvents[K]): () => void {
    (this.handlers[event] as Set<BeezyncEvents[K]>).add(handler);
    return () => this.off(event, handler);
  }

  off<K extends keyof BeezyncEvents>(event: K, handler: BeezyncEvents[K]): void {
    (this.handlers[event] as Set<BeezyncEvents[K]>).delete(handler);
  }

  onMessage(handler: (m: BeezyncMessage) => void): () => void {
    return this.on('message', handler);
  }

  private emit<K extends keyof BeezyncEvents>(event: K, ...args: Parameters<BeezyncEvents[K]>): void {
    for (const h of [...(this.handlers[event] as Set<(...a: any[]) => void>)]) {
      try {
        h(...args);
      } catch {
        // a faulty listener must not break the socket loop
      }
    }
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    try {
      const res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.publicKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: any;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      if (res.ok) return { ok: true, status: res.status, data: parsed as T };
      return { ok: false, status: res.status, error: parsed?.error ?? text, code: parsed?.code };
    } catch (e) {
      return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e), code: 'network_error' };
    }
  }

  async registerDevice(input: RegisterDeviceInput): Promise<Result> {
    this.deviceToken = input.token;
    if (input.externalUserId !== undefined) this.externalUserId = input.externalUserId;
    const body: Record<string, unknown> = { token: input.token, platform: input.platform };
    if (input.externalUserId !== undefined) body.external_user_id = input.externalUserId;
    if (input.tags !== undefined) body.tags = input.tags;
    return this.request('POST', '/v1/api/register-device', body);
  }

  async unregisterDevice(token: string | undefined = this.deviceToken): Promise<Result> {
    if (!token) return { ok: false, status: 0, error: 'no device token', code: 'no_token' };
    const res = await this.request('POST', '/v1/api/unregister-device', { token });
    if (res.ok && token === this.deviceToken) this.deviceToken = undefined;
    return res;
  }

  async setUser(externalUserId: string): Promise<Result> {
    this.externalUserId = externalUserId;
    return this.patchDevice({ external_user_id: externalUserId });
  }

  async setTags(tags: Tags): Promise<Result> {
    return this.patchDevice({ tags });
  }

  private patchDevice(fields: Record<string, unknown>): Promise<Result> {
    if (!this.deviceToken) {
      return Promise.resolve({ ok: false, status: 0, error: 'device not registered', code: 'no_token' });
    }
    return this.request('PATCH', '/v1/api/devices', { token: this.deviceToken, ...fields });
  }

  trackReceived(id: string): Promise<Result> {
    return this.track(id, 'received');
  }

  trackClicked(id: string): Promise<Result> {
    return this.track(id, 'clicked');
  }

  trackDismissed(id: string): Promise<Result> {
    return this.track(id, 'dismissed');
  }

  private track(id: string, event: TrackEvent): Promise<Result> {
    if (!id) return Promise.resolve({ ok: false, status: 0, error: 'missing notification id', code: 'no_id' });
    const body: Record<string, unknown> = { notification_id: id, event };
    if (this.deviceToken) body.token = this.deviceToken;
    return this.request('POST', '/v1/api/notification-events', body);
  }

  connect(): void {
    this.wantConnected = true;
    this.clearReconnect();
    if (this.socket) return;
    this.open();
  }

  disconnect(): void {
    this.wantConnected = false;
    this.clearReconnect();
    this.clearPing();
    const s = this.socket;
    this.socket = undefined;
    const wasOpen = this.socketId !== '';
    this.socketId = '';
    if (s) {
      detach(s);
      try {
        s.close(1000, 'client disconnect');
      } catch {
        // already closed
      }
      if (wasOpen) this.emit('close', { code: 1000, reason: 'client disconnect', willReconnect: false });
    }
  }

  subscribe(channel: string, auth?: SubscribeAuth | string): void {
    const a: SubscribeAuth | undefined = typeof auth === 'string' ? { auth } : auth;
    this.channels.set(channel, a);
    if (this.connected) void this.sendSubscribe(channel, a);
  }

  unsubscribe(channel: string): void {
    this.channels.delete(channel);
    if (this.connected) this.send({ action: 'unsubscribe', channel });
  }

  private open(): void {
    const wsBase = this.baseUrl.replace(/^http/i, 'ws');
    const url = `${wsBase}/v1/ws?app_id=${encodeURIComponent(this.appId)}&key=${encodeURIComponent(this.publicKey)}`;
    let s: SocketLike;
    try {
      s = this.createSocket(url);
    } catch {
      this.scheduleReconnect(false);
      return;
    }
    this.socket = s;
    s.onmessage = (ev) => {
      if (this.socket !== s) return;
      const frame = parseFrame(ev.data);
      if (!frame) return;
      switch (frame.type) {
        case 'connection_established':
          this.attempt = 0;
          this.socketId = frame.socketId || 'unknown';
          this.startPing();
          this.emit('open', { socketId: this.socketId });
          for (const [ch, a] of this.channels) void this.sendSubscribe(ch, a);
          break;
        case 'subscription_succeeded':
          this.emit('subscribed', frame.channel);
          break;
        case 'subscription_error':
          this.emit('subscription_error', { channel: frame.channel, error: frame.error });
          break;
        case 'message':
          this.emit('message', frame.message);
          break;
      }
    };
    s.onclose = (ev) => {
      if (this.socket !== s) return;
      this.socket = undefined;
      this.socketId = '';
      this.clearPing();
      const code = ev?.code ?? 1006;
      this.emit('close', { code, reason: ev?.reason ?? '', willReconnect: this.wantConnected });
      if (this.wantConnected) this.scheduleReconnect(code === RECONNECT_NOW_CODE);
    };
    s.onerror = () => {
      // the close event follows and drives the reconnect
    };
  }

  private async sendSubscribe(channel: string, a?: SubscribeAuth): Promise<void> {
    const frame: Record<string, unknown> = { action: 'subscribe', channel };
    try {
      let creds = { auth: a?.auth, token: a?.token };
      if (a?.authorize) creds = { ...creds, ...(await a.authorize(this.socketId, channel)) };
      if (creds.auth) frame.auth = creds.auth;
      if (creds.token) frame.token = creds.token;
    } catch (e) {
      this.emit('subscription_error', { channel, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.send(frame);
  }

  private send(frame: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      // socket closing; reconnect logic handles it
    }
  }

  private scheduleReconnect(immediate: boolean): void {
    this.clearReconnect();
    const delay = immediate ? 0 : backoffDelay(this.attempt++, this.minBackoff, this.maxBackoff, this.random);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      if (this.wantConnected && !this.socket) this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private startPing(): void {
    this.clearPing();
    if (this.pingInterval <= 0) return;
    const tick = () => {
      this.send({ action: 'ping' });
      this.pingTimer = this.setTimer(tick, this.pingInterval);
    };
    this.pingTimer = this.setTimer(tick, this.pingInterval);
  }

  private clearPing(): void {
    if (this.pingTimer !== undefined) this.clearTimer(this.pingTimer);
    this.pingTimer = undefined;
  }
}

function detach(s: SocketLike): void {
  s.onopen = null;
  s.onmessage = null;
  s.onclose = null;
  s.onerror = null;
}
