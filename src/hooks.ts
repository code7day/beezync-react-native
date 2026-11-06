import { useEffect, useRef, useState } from 'react';
import type { BeezyncClient } from './client';
import type { BeezyncMessage } from './types';

export interface UseBeezyncOptions {
  channels?: string[];
  autoConnect?: boolean;
  maxMessages?: number;
}

export function useBeezync(client: BeezyncClient, options: UseBeezyncOptions = {}) {
  const { autoConnect = true, maxMessages = 100 } = options;
  const channelsKey = (options.channels ?? []).join('\n');
  const [connected, setConnected] = useState(client.connected);
  const [messages, setMessages] = useState<BeezyncMessage[]>([]);
  const channelsRef = useRef<string[]>([]);

  useEffect(() => {
    const offs = [
      client.on('open', () => setConnected(true)),
      client.on('close', () => setConnected(false)),
      client.on('message', (m) => setMessages((prev) => [m, ...prev].slice(0, maxMessages))),
    ];
    if (autoConnect) client.connect();
    return () => {
      offs.forEach((off) => off());
      if (autoConnect) client.disconnect();
    };
  }, [client, autoConnect, maxMessages]);

  useEffect(() => {
    const next = channelsKey ? channelsKey.split('\n') : [];
    for (const c of channelsRef.current) if (!next.includes(c)) client.unsubscribe(c);
    for (const c of next) client.subscribe(c);
    channelsRef.current = next;
  }, [client, channelsKey]);

  return { connected, messages, clear: () => setMessages([]) };
}
