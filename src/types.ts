export type Platform = 'ios' | 'android';
export type TrackEvent = 'received' | 'clicked' | 'dismissed';
export type Tags = Record<string, unknown>;

export interface FetchLike {
  (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface SocketLike {
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: any) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface BeezyncConfig {
  appId: string;
  publicKey: string;
  baseUrl: string;
  fetch?: FetchLike;
  createSocket?: SocketFactory;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  pingIntervalMs?: number;
}

export interface Result<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  code?: string;
}

export interface RegisterDeviceInput {
  token: string;
  platform: Platform;
  externalUserId?: string;
  tags?: Tags;
}

export interface SubscribeAuth {
  auth?: string;
  token?: string;
  authorize?: (socketId: string, channel: string) => Promise<{ auth?: string; token?: string }>;
}

export interface EventMessage {
  kind: 'event';
  event: string;
  channel: string;
  data: unknown;
  id?: string;
  ts?: number;
}

export interface NotificationMessage {
  kind: 'notification';
  id: string;
  title: string;
  body: string;
  channel?: string;
  data?: Record<string, unknown>;
}

export type BeezyncMessage = EventMessage | NotificationMessage;

export interface CloseInfo {
  code: number;
  reason: string;
  willReconnect: boolean;
}

export interface BeezyncEvents {
  message: (message: BeezyncMessage) => void;
  open: (info: { socketId: string }) => void;
  close: (info: CloseInfo) => void;
  subscribed: (channel: string) => void;
  subscription_error: (info: { channel: string; error: string }) => void;
}
