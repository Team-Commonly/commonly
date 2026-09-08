import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';
import axios from 'axios';
import getApiBaseUrl from '../utils/apiBaseUrl';

interface SocketContextValue {
  socket: Socket | null;
  connected: boolean;
  pgAvailable: boolean;
  joinPod: (podId: string) => void;
  leavePod: (podId: string) => void;
  sendMessage: (podId: string, content: string, messageType?: string, replyToMessageId?: string | null) => void;
}

const SocketContext = createContext<SocketContextValue | undefined>(undefined);

export const useSocket = (): SocketContextValue => {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket must be used within SocketProvider');
  return ctx;
};

export const useSocketContext = (): SocketContextValue => useSocket();

interface SocketProviderProps {
  children: React.ReactNode;
}

export const SocketProvider: React.FC<SocketProviderProps> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [pgAvailable, setPgAvailable] = useState(false);
  const { token, currentUser } = useAuth();
  // Socket rooms are owned by the shared connection, while consumers mount
  // independently (board, chat, and detail can all observe one pod). Keep a
  // small ownership count so one consumer cannot evict another consumer's
  // room membership during cleanup.
  const podConsumerCountsRef = useRef<Map<string, number>>(new Map());
  const joinedPodsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const checkPgAvailability = async () => {
      try {
        const response = await axios.get<{ available: boolean }>('/api/pg/status');
        setPgAvailable(response.data.available);
        if (response.data.available && token && currentUser?._id) {
          try {
            await axios.post('/api/pg/status/sync-user', {}, {
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch (err: unknown) {
            const e = err as { message?: string };
            console.error('Error syncing user to PostgreSQL:', e.message);
          }
        } else if (response.data.available && !currentUser?._id) {
          console.warn('User data is not fully loaded yet, skipping PostgreSQL sync');
        }
      } catch (err: unknown) {
        const e = err as { message?: string };
        console.error('PostgreSQL not available:', e.message);
        setPgAvailable(false);
      }
    };

    if (token && currentUser) {
      checkPgAvailability();
    }
  }, [token, currentUser?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (token && currentUser?._id) {
      const apiUrl = getApiBaseUrl();
      const newSocket = io(apiUrl, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        // Eskiden 5 denemeydi (1sn arayla): laptop uykusu / ağ blip'i / backend
        // deploy'u gibi ~5 saniyeden uzun her kesintide socket.io KALICI olarak
        // pes ediyordu. Sayfa açık kalıyor, REST ile yüklenmiş eski mesajlar
        // duruyor, yeni hiçbir şey gelmiyor — kullanıcı bayat veriye bakıp
        // "mesajım gitmedi mi?" diyor (canlı gözlendi 2026-07-16: sekme ~1 saat
        // açık kaldıktan sonra sessizce ölü). Pod'u açık bırakıp agentları
        // izlemek bu üründe beklenen kullanım; kalıcı pes etmek kabul edilemez.
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        randomizationFactor: 0.5,
      });

      newSocket.on('connect', () => {
        // A reconnect drops server-side rooms even when React never observed
        // a render between disconnect and connect. Restore every live owner.
        joinedPodsRef.current.clear();
        podConsumerCountsRef.current.forEach((owners, podId) => {
          if (owners > 0) {
            newSocket.emit('joinPod', podId);
            joinedPodsRef.current.add(podId);
          }
        });
        setConnected(true);
      });
      newSocket.on('connect_error', (error: Error) => {
        console.error('Socket connection error:', error.message);
        joinedPodsRef.current.clear();
        setConnected(false);
      });
      newSocket.on('disconnect', (reason: string) => {
        console.log('Socket disconnected, reason:', reason);
        // Socket.IO drops all server-side rooms on disconnect. Forget local
        // ownership too so the next connected effect emits a fresh join.
        joinedPodsRef.current.clear();
        setConnected(false);
      });
      newSocket.on('error', (error: unknown) => {
        console.error('Socket error:', error);
        joinedPodsRef.current.clear();
        setConnected(false);
      });

      // Backoff 30sn'ye kadar çıkabildiği için, kullanıcı sekmeye döndüğünde ya
      // da ağ geri geldiğinde bir sonraki denemeyi beklemek yerine hemen bağlan.
      // io.disconnect() sonrası (sunucu tarafı kapatma) otomatik yeniden bağlanma
      // devreye girmez — bu iki olay o durumun da tek kurtarma yoludur.
      const reconnectNow = (): void => {
        if (!newSocket.connected) newSocket.connect();
      };
      const onVisible = (): void => { if (document.visibilityState === 'visible') reconnectNow(); };
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('online', reconnectNow);
      window.addEventListener('focus', reconnectNow);

      setSocket(newSocket);
      return () => {
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('online', reconnectNow);
        window.removeEventListener('focus', reconnectNow);
        joinedPodsRef.current.clear();
        podConsumerCountsRef.current.clear();
        setSocket((current) => (current === newSocket ? null : current));
        setConnected(false);
        newSocket.disconnect();
      };
    }
  }, [token, currentUser?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const joinPod = useCallback((podId: string): void => {
    if (!podId) return;
    const owners = podConsumerCountsRef.current.get(podId) || 0;
    podConsumerCountsRef.current.set(podId, owners + 1);
    if (socket && connected && !joinedPodsRef.current.has(podId)) {
      socket.emit('joinPod', podId);
      joinedPodsRef.current.add(podId);
    }
  }, [socket, connected]);

  const leavePod = useCallback((podId: string): void => {
    if (!podId) return;
    const owners = podConsumerCountsRef.current.get(podId) || 0;
    if (owners <= 1) {
      podConsumerCountsRef.current.delete(podId);
      if (socket && connected && joinedPodsRef.current.has(podId)) {
        socket.emit('leavePod', podId);
        joinedPodsRef.current.delete(podId);
      }
      return;
    }
    podConsumerCountsRef.current.set(podId, owners - 1);
  }, [socket, connected]);

  const sendMessage = (
    podId: string,
    content: string,
    messageType = 'text',
    replyToMessageId: string | null = null,
  ): void => {
    if (socket && connected && currentUser?._id && podId) {
      socket.emit('sendMessage', {
        podId,
        content,
        messageType,
        userId: currentUser._id,
        ...(replyToMessageId && { replyToMessageId }),
      });
    }
  };

  return (
    <SocketContext.Provider value={{ socket, connected, pgAvailable, joinPod, leavePod, sendMessage }}>
      {children}
    </SocketContext.Provider>
  );
};
