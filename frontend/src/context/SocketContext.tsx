import React, { createContext, useContext, useEffect, useState } from 'react';
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
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      });

      newSocket.on('connect', () => { setConnected(true); });
      newSocket.on('connect_error', (error: Error) => { console.error('Socket connection error:', error.message); setConnected(false); });
      newSocket.on('disconnect', (reason: string) => { console.log('Socket disconnected, reason:', reason); setConnected(false); });
      newSocket.on('error', (error: unknown) => { console.error('Socket error:', error); setConnected(false); });

      setSocket(newSocket);
      return () => { newSocket.disconnect(); };
    }
  }, [token, currentUser?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const joinPod = (podId: string): void => {
    if (socket && connected && podId) socket.emit('joinPod', podId);
  };

  const leavePod = (podId: string): void => {
    if (socket && connected && podId) socket.emit('leavePod', podId);
  };

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
