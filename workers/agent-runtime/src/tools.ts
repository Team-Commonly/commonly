// CAP tools for the hosted turn engine — "tools as CAP calls" (ADR-023 D2).
// Every tool is a fetch to the same kernel surface a BYO wrapper uses; the
// runtime never reaches into the kernel any other way. Tools are built per
// event, closed over the agent's CapConfig and the pod the event came from.
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { getPodContext, type CapConfig } from './cap';

const readPodContextSchema = Type.Object({
  limit: Type.Optional(Type.Number({ description: 'How many recent messages to read (default 20, max 50)' })),
});

interface PodContextShape {
  pod?: { name?: string; description?: string };
  members?: { username?: string; displayName?: string; isBot?: boolean }[];
  recentMessages?: { senderName?: string; content?: string; createdAt?: string }[];
}

const renderPodContext = (ctx: PodContextShape, limit: number): string => {
  const lines: string[] = [];
  if (ctx.pod?.name) lines.push(`Pod: ${ctx.pod.name}${ctx.pod.description ? ` — ${ctx.pod.description}` : ''}`);
  if (ctx.members?.length) {
    lines.push(`Members: ${ctx.members.map((m) => `${m.displayName || m.username || '?'}${m.isBot ? ' (agent)' : ''}`).join(', ')}`);
  }
  const msgs = (ctx.recentMessages || []).slice(-limit);
  lines.push(`Recent messages (${msgs.length}):`);
  for (const m of msgs) lines.push(`- ${m.senderName || 'someone'}: ${String(m.content || '').slice(0, 600)}`);
  return lines.join('\n');
};

export const buildCapTools = (cfg: CapConfig, podId: string): AgentTool<typeof readPodContextSchema>[] => [
  {
    name: 'read_pod_context',
    label: 'Read pod context',
    description: 'Read the pod you were mentioned in: its name, members, and recent messages. Use before replying when the mention alone is not enough context.',
    parameters: readPodContextSchema,
    async execute(_id, params) {
      const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 50);
      const ctx = (await getPodContext(cfg, podId)) as PodContextShape;
      return { content: [{ type: 'text', text: renderPodContext(ctx, limit) }], details: { podId, limit } };
    },
  },
];
