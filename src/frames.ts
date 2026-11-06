import type { BeezyncMessage } from './types';

export type Frame =
  | { type: 'connection_established'; socketId: string }
  | { type: 'subscription_succeeded'; channel: string }
  | { type: 'subscription_error'; channel: string; error: string }
  | { type: 'pong' }
  | { type: 'message'; message: BeezyncMessage };

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

function unwrap(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

export function parseFrame(raw: unknown): Frame | null {
  if (typeof raw !== 'string') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(obj)) return null;

  if (typeof obj.event === 'string') {
    switch (obj.event) {
      case 'connection_established': {
        const d = unwrap(obj.data);
        const socketId = isObject(d) && typeof d.socket_id === 'string' ? d.socket_id : '';
        return { type: 'connection_established', socketId };
      }
      case 'subscription_succeeded':
        return { type: 'subscription_succeeded', channel: String(obj.channel ?? '') };
      case 'subscription_error':
        return { type: 'subscription_error', channel: String(obj.channel ?? ''), error: String(obj.error ?? '') };
      case 'pong':
        return { type: 'pong' };
    }
    return {
      type: 'message',
      message: {
        kind: 'event',
        event: obj.event,
        channel: String(obj.channel ?? ''),
        data: obj.data,
        id: typeof obj.id === 'string' ? obj.id : undefined,
        ts: typeof obj.ts === 'number' ? obj.ts : undefined,
      },
    };
  }

  if (typeof obj.id === 'string' && (typeof obj.title === 'string' || typeof obj.body === 'string')) {
    return {
      type: 'message',
      message: {
        kind: 'notification',
        id: obj.id,
        title: String(obj.title ?? ''),
        body: String(obj.body ?? ''),
        channel: typeof obj.channel === 'string' ? obj.channel : undefined,
        data: isObject(obj.data) ? obj.data : undefined,
      },
    };
  }
  return null;
}
