import { io, type Socket } from "socket.io-client";

import type { CommonlyEvent } from "./events.js";

export type CommonlyWebSocketConfig = {
  baseUrl: string;
  runtimeToken: string;
  podIds?: string[];
};

type StatusHandler = (status: { connected: boolean; reason?: string; error?: string }) => void;
type EventHandler = (event: CommonlyEvent) => void;

export class CommonlyWebSocket {
  private config: CommonlyWebSocketConfig;
  private socket: Socket | null = null;
  private eventHandlers: EventHandler[] = [];
  private statusHandlers: StatusHandler[] = [];

  constructor(config: CommonlyWebSocketConfig) {
    this.config = config;
  }

  private emitStatus(status: { connected: boolean; reason?: string; error?: string }) {
    this.statusHandlers.forEach((handler) => handler(status));
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.push(handler);
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.push(handler);
  }

  async connect(): Promise<void> {
    if (this.socket?.connected) return;

    const base = new URL(this.config.baseUrl);
    const socketUrl = `${base.origin}/agents`;

    this.socket = io(socketUrl, {
      auth: { token: this.config.runtimeToken },
      transports: ["websocket"],
      reconnection: true,
    });

    this.socket.on("event", (event: CommonlyEvent) => {
      this.eventHandlers.forEach((handler) => handler(event));
    });

    this.socket.on("connect", () => {
      this.emitStatus({ connected: true });
    });

    this.socket.on("disconnect", (reason) => {
      this.emitStatus({ connected: false, reason });
    });

    this.socket.on("connect_error", (err) => {
      this.emitStatus({ connected: false, error: err?.message || String(err) });
    });

    await new Promise<void>((resolve, reject) => {
      const handleConnect = () => {
        this.socket?.off("connect_error", handleError);
        resolve();
      };
      const handleError = (err: unknown) => {
        this.socket?.off("connect", handleConnect);
        reject(err);
      };
      this.socket?.once("connect", handleConnect);
      this.socket?.once("connect_error", handleError);
    });
  }

  subscribe(podIds: string[]): void {
    if (!this.socket) return;
    if (!Array.isArray(podIds) || podIds.length === 0) return;
    this.socket.emit("subscribe", { podIds });
  }

  unsubscribe(podIds: string[]): void {
    if (!this.socket) return;
    if (!Array.isArray(podIds) || podIds.length === 0) return;
    this.socket.emit("unsubscribe", { podIds });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  isConnected(): boolean {
    return Boolean(this.socket?.connected);
  }
}
