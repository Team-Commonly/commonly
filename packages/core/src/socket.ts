import { io, type Socket } from 'socket.io-client';
import type { Session } from './session';
import type { Message } from './pods';

export type LiveEvent =
  | { type: 'newMessage'; message: Message }
  | { type: 'messageReaction'; payload: unknown }
  | { type: 'messageCardUpdated'; payload: unknown };

/**
 * The live connection. Same handshake the old shell used (`auth: { token }`,
 * websocket then polling), but owned here instead of inside a React context,
 * so a desktop shell can hold one connection for several windows and a test
 * can hand it a fake socket.
 */
export class Live {
  private socket: Socket | null = null;
  private listeners = new Set<(event: LiveEvent) => void>();

  constructor(private readonly session: Session, private readonly ioImpl: typeof io = io) {}

  async connect(): Promise<Socket | null> {
    const token = await this.session.token();
    if (!token) return null;
    if (this.socket) return this.socket;
    const socket = this.ioImpl(this.session.baseUrl, { auth: { token }, transports: ['websocket', 'polling'] });
    socket.on('newMessage', (message: Message) => this.emit({ type: 'newMessage', message }));
    socket.on('messageReaction', (payload: unknown) => this.emit({ type: 'messageReaction', payload }));
    socket.on('messageCardUpdated', (payload: unknown) => this.emit({ type: 'messageCardUpdated', payload }));
    this.socket = socket;
    return socket;
  }

  /** Join a pod's room so its messages stream. Safe to call before connect(); it is replayed on connect. */
  joinPod(podId: string): void {
    this.socket?.emit('joinPod', podId);
  }

  on(fn: (event: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  private emit(event: LiveEvent) {
    this.listeners.forEach((fn) => fn(event));
  }
}
