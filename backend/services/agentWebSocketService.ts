// eslint-disable-next-line global-require
const jwt = require('jsonwebtoken');
// eslint-disable-next-line global-require
const AgentEventService = require('./agentEventService');
// eslint-disable-next-line global-require
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const User = require('../models/User');
// eslint-disable-next-line global-require
const { hash } = require('../utils/secret');

interface AgentSocket {
  agentName: string;
  instanceId: string;
  agentUserId: string | null;
  agentKey: string;
  subscribedPods: Set<string>;
  handshake: { auth?: { token?: string } };
  join(room: string): void;
  leave(room: string): void;
  emit(event: string, data?: unknown): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  connected: boolean;
}

interface AgentNamespace {
  use(fn: (socket: AgentSocket, next: (err?: Error) => void) => void): void;
  on(event: string, handler: (socket: AgentSocket) => void): void;
  to(room: string): { emit(event: string, data?: unknown): void };
  emit(event: string, data?: unknown): void;
}

interface IoServer {
  of(namespace: string): AgentNamespace;
}

interface ConnectedAgentData {
  socket: AgentSocket;
  lastPong: number;
}

interface AgentTokenInfo {
  agentName: string;
  instanceId: string;
  agentUserId?: string;
  podId?: unknown;
}

interface AgentEvent {
  _id?: unknown;
  type?: string;
  agentName: string;
  instanceId?: string;
  podId?: unknown;
  payload?: { trigger?: string };
  // ADR-026 D6, set only when the event was already claimed at enqueue time
  // (native runs are born 'delivered'). Absent on the pending-queue routes —
  // see the comment at the pushEvent call site in agentEventService.
  deliveryId?: string;
}

interface AgentUserDoc {
  _id?: unknown;
  username?: string;
  isBot?: boolean;
  botMetadata?: Record<string, unknown>;
  agentRuntimeTokens?: Array<{ tokenHash: string; lastUsedAt?: Date }>;
}

interface InstallationDoc {
  _id?: unknown;
  agentName: string;
  instanceId?: string;
  podId?: unknown;
  status?: string;
  displayName?: string;
  runtimeTokens?: Array<{ tokenHash: string; lastUsedAt?: Date }>;
}

const normalizeTokenIdentityValue = (value: unknown): string => (
  String(value || '').trim().toLowerCase()
);

const deriveInstanceIdFromUsername = (agentName: string, username: string): string | null => {
  const normalizedAgent = normalizeTokenIdentityValue(agentName);
  const normalizedUsername = normalizeTokenIdentityValue(username);
  if (!normalizedAgent || !normalizedUsername) return null;
  if (normalizedUsername === normalizedAgent) return 'default';
  const prefix = `${normalizedAgent}-`;
  if (normalizedUsername.startsWith(prefix)) {
    const suffix = normalizedUsername.slice(prefix.length).trim();
    return suffix || null;
  }
  return null;
};

const resolveTokenAgentIdentity = (agentUser: AgentUserDoc): { agentName: string; instanceId: string } => {
  const meta = (agentUser?.botMetadata || {}) as Record<string, unknown>;
  const username = normalizeTokenIdentityValue(agentUser?.username);
  const agentName = normalizeTokenIdentityValue(meta.agentName || meta.agentType || username);

  const metadataInstanceId = normalizeTokenIdentityValue(meta.instanceId);
  const usernameInstanceId = deriveInstanceIdFromUsername(agentName, username);
  let instanceId = metadataInstanceId || usernameInstanceId || 'default';
  if (usernameInstanceId && (!metadataInstanceId || metadataInstanceId === 'default')) {
    instanceId = usernameInstanceId;
  }

  return { agentName, instanceId };
};

class AgentWebSocketService {
  private io: IoServer | null;

  private agentNamespace: AgentNamespace | null;

  private connectedAgents: Map<string, ConnectedAgentData>;

  private pingInterval: NodeJS.Timeout | null;

  constructor() {
    this.io = null;
    this.agentNamespace = null;
    this.connectedAgents = new Map();
    this.pingInterval = null;
  }

  init(io: IoServer): void {
    this.io = io;
    this.agentNamespace = io.of('/agents');

    this.agentNamespace.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (!token) {
          return next(new Error('Authentication required'));
        }

        const agentInfo = await this.validateAgentToken(token);
        if (!agentInfo) {
          return next(new Error('Invalid agent token'));
        }

        socket.agentName = agentInfo.agentName;
        socket.instanceId = agentInfo.instanceId || 'default';
        socket.agentUserId = agentInfo.agentUserId || null;
        socket.agentKey = `${socket.agentName}:${socket.instanceId}`;
        socket.subscribedPods = new Set();

        return next();
      } catch (err) {
        return next(new Error(`Authentication failed: ${(err as Error).message}`));
      }
    });

    this.agentNamespace.on('connection', (socket) => {
      console.log(`[agent-ws] Agent connected: ${socket.agentKey}`);

      this.connectedAgents.set(socket.agentKey, {
        socket,
        lastPong: Date.now(),
      });

      socket.join(`agent:${socket.agentKey}`);

      this.replayPendingEvents(socket);

      socket.on('subscribe', (payload: unknown) => {
        const { podIds } = payload as { podIds?: unknown[] };
        if (!Array.isArray(podIds)) return;

        podIds.forEach((podId) => {
          socket.join(`pod:${podId}`);
          socket.subscribedPods.add(String(podId));
        });

        console.log(`[agent-ws] ${socket.agentKey} subscribed to ${podIds.length} pods`);
      });

      socket.on('unsubscribe', (payload: unknown) => {
        const { podIds } = payload as { podIds?: unknown[] };
        if (!Array.isArray(podIds)) return;

        podIds.forEach((podId) => {
          socket.leave(`pod:${podId}`);
          socket.subscribedPods.delete(String(podId));
        });
      });

      socket.on('pong', () => {
        const data = this.connectedAgents.get(socket.agentKey);
        if (data) {
          data.lastPong = Date.now();
        }
      });

      socket.on('ack', async (payload: unknown) => {
        const { eventId, deliveryId } = payload as { eventId?: string; deliveryId?: string };
        if (!eventId) return;

        try {
          // ADR-026 D6 at the socket boundary. This handler used to call
          // acknowledge() with three arguments and emit ack:success whatever
          // came back — the exact lie the two HTTP handlers grew a 400 to
          // prevent, on a live surface (review on #1347). Under Phase B every
          // WS ack would take the `return null` branch, the socket would
          // report success, and the event would be requeued and redelivered.
          if (!deliveryId && AgentEventService.isDeliveryNonceRequired()) {
            socket.emit('ack:error', {
              eventId,
              code: 'delivery_id_required',
              error: 'This instance requires the deliveryId from the event payload on ack',
            });
            return;
          }
          const acked = await AgentEventService.acknowledge(
            eventId,
            socket.agentName,
            socket.instanceId,
            null,
            deliveryId || null,
          );
          if (!acked && await AgentEventService.isSupersededDelivery(
            eventId, socket.agentName, socket.instanceId, deliveryId || null,
          )) {
            socket.emit('ack:error', {
              eventId,
              code: 'stale_delivery',
              error: 'This delivery was superseded by a requeue',
            });
            return;
          }
          console.log(`[agent-ws] Ack received from ${socket.agentKey} for event ${eventId}`);
          socket.emit('ack:success', { eventId });
        } catch (err) {
          console.warn(`[agent-ws] Ack failed from ${socket.agentKey} for event ${eventId}: ${(err as Error).message}`);
          socket.emit('ack:error', { eventId, error: (err as Error).message });
        }
      });

      socket.on('disconnect', (reason: unknown) => {
        console.log(`[agent-ws] Agent disconnected: ${socket.agentKey} (${reason})`);
        this.connectedAgents.delete(socket.agentKey);
      });

      socket.emit('connected', {
        agentName: socket.agentName,
        instanceId: socket.instanceId,
        message: 'Connected to Commonly agent WebSocket',
      });
    });

    this.startPingInterval();

    console.log('[agent-ws] Agent WebSocket namespace initialized on /agents');
  }

  async replayPendingEvents(socket: AgentSocket, limit = 50): Promise<void> {
    try {
      const installations = await AgentInstallation.find({
        agentName: socket.agentName.toLowerCase(),
        instanceId: socket.instanceId || 'default',
        status: 'active',
      }).select('podId').lean() as Array<{ podId?: unknown }>;

      const installationPodIds = Array.from(
        new Set(
          (installations || [])
            .map((installation) => installation?.podId?.toString())
            .filter(Boolean) as string[],
        ),
      );

      let dmPodIds: string[] = [];
      if (socket.agentUserId) {
        const dmPods = await Pod.find({
          type: 'agent-admin',
          members: socket.agentUserId,
        }).select('_id').lean() as Array<{ _id?: unknown }>;
        dmPodIds = dmPods.map((pod) => pod?._id?.toString()).filter(Boolean) as string[];
      }
      const podIds = Array.from(new Set([...installationPodIds, ...dmPodIds]));

      if (!podIds.length) return;

      const events = await AgentEventService.list({
        agentName: socket.agentName,
        instanceId: socket.instanceId || 'default',
        podIds,
        limit,
      }) as AgentEvent[];

      if (!events.length) return;

      events.forEach((event) => {
        socket.emit('event', event);
      });

      console.log(`[agent-ws] Replayed ${events.length} pending event(s) for ${socket.agentKey}`);
    } catch (error) {
      console.warn(`[agent-ws] Failed to replay pending events for ${socket?.agentKey}: ${(error as Error).message}`);
    }
  }

  startPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      const now = Date.now();
      const staleThreshold = 90000;

      this.connectedAgents.forEach((data, agentKey) => {
        const { socket, lastPong } = data;

        if (now - lastPong > staleThreshold) {
          console.log(`[agent-ws] Stale connection detected: ${agentKey} (last pong ${Math.round((now - lastPong) / 1000)}s ago)`);
        }

        if (socket?.connected) {
          socket.emit('ping');
        }
      });
    }, 30000);
  }

  stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  async validateAgentToken(token: string): Promise<AgentTokenInfo | null> {
    if (token.startsWith('cm_agent_')) {
      try {
        const tokenHash = hash(token);
        // ADR-026 Phase 0: the credential ledger gates the WS transport with
        // the same semantics as the HTTP middleware — a revoked credential
        // (or a child of a revoked issuer) must not connect over WS either
        // (Vera's bypass finding on #1312).
        // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
        const AgentCredential = require('../models/AgentCredential');
        // The ledger is an assertion, not a filtered runtime lookup: a daemon
        // hash in a legacy token list must veto the WS fallback too.
        const credential = await AgentCredential.findOne({ tokenHash });
        if (credential) {
          if (credential.kind !== 'runtime') return null;
          if (credential.status !== 'active') return null;
          if (credential.expiresAt && credential.expiresAt < new Date()) return null;
          if (credential.parentId) {
            const parent = await AgentCredential.findById(credential.parentId).select('status').lean();
            if (!parent || parent.status !== 'active') return null;
          }
        }
        const agentUser = await User.findOne({
          'agentRuntimeTokens.tokenHash': tokenHash,
          isBot: true,
        }) as AgentUserDoc | null;

        if (agentUser) {
          // Pre-update: no lastUsedAt = first-ever authentication. The WS
          // transport stamps the same field the HTTP middleware does, so
          // skipping the hook here would swallow the first-use signal for
          // WS-first agents permanently (#916).
          const wsTokenRecord = (agentUser.agentRuntimeTokens || [])
            .find((t: { tokenHash?: string; lastUsedAt?: Date }) => t.tokenHash === tokenHash);
          const isFirstTokenUse = !wsTokenRecord?.lastUsedAt;
          try {
            await User.updateOne(
              { _id: agentUser._id, 'agentRuntimeTokens.tokenHash': tokenHash },
              { $set: { 'agentRuntimeTokens.$.lastUsedAt': new Date() } },
            );
          } catch (err) {
            console.warn('Failed to update agent token usage on User:', (err as Error).message);
          }

          const { agentName, instanceId } = resolveTokenAgentIdentity(agentUser);

          if (agentName) {
            if (isFirstTokenUse) {
              try {
                const installs = await AgentInstallation.find({
                  agentName, instanceId, status: 'active',
                }).select('podId').lean() as Array<{ podId?: { toString: () => string } }>;
                // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
                const { completeConnectAgentStarterTask } = require('./starterTaskService');
                void completeConnectAgentStarterTask({
                  podIds: installs.map((i) => i?.podId?.toString()),
                  agentLabel: (agentUser as { botMetadata?: { displayName?: string } })
                    .botMetadata?.displayName || agentName,
                });
              } catch (starterErr) {
                console.warn('[agent-ws] starter-task hook failed:', (starterErr as Error).message);
              }
            }
            return { agentName, instanceId, agentUserId: String(agentUser._id || '') };
          }
        }

        const installation = await AgentInstallation.findOne({
          'runtimeTokens.tokenHash': tokenHash,
          status: 'active',
        }) as InstallationDoc | null;

        if (installation) {
          const wsInstallTokenRecord = (installation.runtimeTokens || [])
            .find((t: { tokenHash?: string; lastUsedAt?: Date }) => t.tokenHash === tokenHash);
          const isFirstLegacyUse = !wsInstallTokenRecord?.lastUsedAt;
          try {
            await AgentInstallation.updateOne(
              { _id: installation._id, 'runtimeTokens.tokenHash': tokenHash },
              { $set: { 'runtimeTokens.$.lastUsedAt': new Date() } },
            );
          } catch (err) {
            console.warn('Failed to update agent token usage:', (err as Error).message);
          }

          if (isFirstLegacyUse) {
            try {
              // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
              const { completeConnectAgentStarterTask } = require('./starterTaskService');
              void completeConnectAgentStarterTask({
                podIds: [installation.podId ? String(installation.podId) : null],
                agentLabel: installation.displayName || installation.agentName,
              });
            } catch (starterErr) {
              console.warn('[agent-ws] starter-task hook failed:', (starterErr as Error).message);
            }
          }

          return {
            agentName: installation.agentName,
            instanceId: installation.instanceId || 'default',
            podId: installation.podId,
          };
        }
      } catch {
        // Continue to JWT validation
      }
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET) as Record<string, unknown>;
      if (decoded.agentName) {
        return {
          agentName: String(decoded.agentName),
          instanceId: String(decoded.instanceId || 'default'),
        };
      }
    } catch {
      // Token invalid
    }

    return null;
  }

  pushEvent(event: AgentEvent): boolean {
    if (!this.agentNamespace) return false;

    const agentKey = `${event.agentName}:${event.instanceId || 'default'}`;
    const target = this.connectedAgents.get(agentKey);

    if (!target) return false;

    if (event.deliveryId) {
      // Native events are born claimed. Their nonce was minted with that
      // claim, so this is already a delivery rather than a queue wake.
      target.socket.emit('event', event);
    } else {
      // A queued event has no delivery nonce until list() atomically claims
      // it. Do not broadcast the raw pending record: a socket that processes
      // that copy cannot later prove which delivery it is acknowledging.
      void this.replayPendingEvents(target.socket);
    }

    console.log(
      `[agent-ws] Event delivery requested id=${event?._id || 'n/a'} type=${event?.type || 'n/a'} `
      + `agent=${agentKey} pod=${event?.podId || 'n/a'} trigger=${event?.payload?.trigger || 'n/a'}`,
    );

    return true;
  }

  isAgentConnected(agentName: string, instanceId = 'default'): boolean {
    return this.connectedAgents.has(`${agentName}:${instanceId}`);
  }

  getConnectedCount(): number {
    return this.connectedAgents.size;
  }

  getConnectedAgents(): string[] {
    return Array.from(this.connectedAgents.keys());
  }

  broadcast(eventName: string, data?: unknown): void {
    if (!this.agentNamespace) return;
    this.agentNamespace.emit(eventName, data);
  }
}

const agentWebSocketService = new AgentWebSocketService();

export default agentWebSocketService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
