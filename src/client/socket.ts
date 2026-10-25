import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Ack, GameView, HostAction } from '../shared/types';

/** One Socket.IO connection per page; `onConnect` (re)authenticates after every reconnect. */
export function useGameSocket(onConnect: (s: Socket) => void, enabled = true) {
  const [view, setView] = useState<GameView | null>(null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;

  useEffect(() => {
    if (!enabled) return;
    const s = io({
      transports: ['websocket'],
      reconnectionDelay: 300,
      reconnectionDelayMax: 2000,
      timeout: 5000,
    });
    socketRef.current = s;
    s.on('connect', () => {
      setConnected(true);
      onConnectRef.current(s);
    });
    s.on('disconnect', () => setConnected(false));
    s.on('state', (v: GameView) => setView(v));
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !s.connected) s.connect();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      s.disconnect();
      socketRef.current = null;
    };
  }, [enabled]);

  return { view, setView, connected, socket: socketRef };
}

export function emitAck<T extends Ack = Ack>(s: Socket | null, event: string, data?: unknown): Promise<T> {
  return new Promise((resolve) => {
    if (!s || !s.connected) return resolve({ ok: false, error: 'Нет соединения с сервером' } as T);
    s.timeout(5000).emit(event, data, (err: unknown, res: T) => {
      if (err) resolve({ ok: false, error: 'Сервер не ответил' } as T);
      else resolve(res);
    });
  });
}

export function hostAction(s: Socket | null, action: HostAction) {
  return emitAck(s, 'host:action', action);
}
