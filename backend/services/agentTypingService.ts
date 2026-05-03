/**
 * agentTypingService
 *
 * Emits agent typing indicators into pod rooms over Socket.io. Called from
 * server-side services (agentEventService, agentMessageService) so other
 * backend code can signal "agent X is working on a response in pod Y"
 * without going through a client socket.
 *
 * A safety timeout ensures a stuck typing_start is automatically cleared
 * after 60s, so a crash between start and stop can never produce a phantom
 * typing indicator.
 */

interface SocketIOLike {
  to: (room: string) => { emit: (event: string, payload: unknown) => void };
}

let ioRef: SocketIOLike | null = null;

export interface TypingAgent {
  podId: unknown;
  agentName: string;
  instanceId?: string;
  displayName: string;
  avatar?: string;
}

const activeTimers = new Map<string, NodeJS.Timeout>();
// 30s safety window — if a typing-stop event is dropped (LLM crash, gateway
// disconnect mid-call), the indicator clears in 30s instead of dragging on
// for a full minute looking fake.
const TIMEOUT_MS = 30_000;

function podKey(t: { podId: unknown; agentName: string; instanceId?: string }): string {
  const podId = t?.podId == null ? '' : String(t.podId);
  const agent = String(t?.agentName || '').toLowerCase();
  const instance = String(t?.instanceId || 'default');
  return `${podId}:${agent}:${instance}`;
}

function normalizeStart(agent: TypingAgent): TypingAgent | null {
  if (!agent || !agent.podId || !agent.agentName) return null;
  return {
    podId: String(agent.podId),
    agentName: String(agent.agentName).toLowerCase(),
    instanceId: agent.instanceId ? String(agent.instanceId) : 'default',
    displayName: String(agent.displayName || agent.agentName),
    avatar: agent.avatar ? String(agent.avatar) : undefined,
  };
}

function normalizeStop(agent: {
  podId: unknown;
  agentName: string;
  instanceId?: string;
}): { podId: string; agentName: string; instanceId: string } | null {
  if (!agent || !agent.podId || !agent.agentName) return null;
  return {
    podId: String(agent.podId),
    agentName: String(agent.agentName).toLowerCase(),
    instanceId: agent.instanceId ? String(agent.instanceId) : 'default',
  };
}

export function bindSocketIO(io: SocketIOLike): void {
  ioRef = io;
}

export function emitAgentTypingStart(agent: TypingAgent): void {
  if (!ioRef) return;
  const normalized = normalizeStart(agent);
  if (!normalized) return;
  try {
    ioRef.to(`pod_${normalized.podId}`).emit('agent_typing_start', normalized);
  } catch (err) {
    console.warn('[agent-typing] emit start failed:', (err as Error).message);
    return;
  }
  const k = podKey(normalized);
  const existing = activeTimers.get(k);
  if (existing) clearTimeout(existing);
  activeTimers.set(
    k,
    setTimeout(() => {
      activeTimers.delete(k);
      emitAgentTypingStop({
        podId: normalized.podId,
        agentName: normalized.agentName,
        instanceId: normalized.instanceId,
      });
    }, TIMEOUT_MS),
  );
}

export function emitAgentTypingStop(agent: {
  podId: unknown;
  agentName: string;
  instanceId?: string;
}): void {
  if (!ioRef) return;
  const normalized = normalizeStop(agent);
  if (!normalized) return;
  try {
    ioRef.to(`pod_${normalized.podId}`).emit('agent_typing_stop', normalized);
  } catch (err) {
    console.warn('[agent-typing] emit stop failed:', (err as Error).message);
  }
  const k = podKey(normalized);
  const existing = activeTimers.get(k);
  if (existing) {
    clearTimeout(existing);
    activeTimers.delete(k);
  }
}

export default {
  bindSocketIO,
  emitAgentTypingStart,
  emitAgentTypingStop,
};

// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
