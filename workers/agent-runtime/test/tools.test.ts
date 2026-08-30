import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCapTools } from '../src/tools';
import { runTurn } from '../src/turn';

const cfg = { apiUrl: 'https://api.test', runtimeToken: 'cm_agent_x' };

describe('CAP tools', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

  it('read_pod_context calls the CAP context route for the event pod and renders it', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({
      pod: { name: 'Rewire', description: 'demo' },
      members: [{ displayName: 'Sam' }, { username: 'vera', isBot: true }],
      recentMessages: [{ senderName: 'Sam', content: 'hello' }, { senderName: 'Vera', content: 'hi' }],
    }) });
    const [tool] = buildCapTools(cfg, 'pod-9');
    expect(tool.name).toBe('read_pod_context');
    const res = await tool.execute('call-1', { limit: 1 });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/agents/runtime/pods/pod-9/context');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Pod: Rewire — demo');
    expect(text).toContain('vera (agent)');
    expect(text).toContain('Recent messages (1)');
    expect(text).toContain('Vera: hi');
    expect(text).not.toContain('Sam: hello');
  });

  it('clamps limit into [1, 50]', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ recentMessages: Array.from({ length: 60 }, (_, i) => ({ content: String(i) })) }) });
    const [tool] = buildCapTools(cfg, 'p');
    const res = await tool.execute('c', { limit: 999 });
    expect((res.content[0] as { text: string }).text).toContain('Recent messages (50)');
  });

  it('runTurn hands the tools to the loop context', async () => {
    const seen: unknown[] = [];
    const loop = (async (_p: unknown, context: { tools?: unknown[] }) => { seen.push(context.tools); return [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }]; }) as never;
    const storage = { get: async () => undefined, put: async () => {} } as unknown as DurableObjectStorage;
    const tools = buildCapTools(cfg, 'p');
    await runTurn({ storage, apiKey: 'k', systemPrompt: 's', loop, tools }, 'hi');
    expect((seen[0] as unknown[]).length).toBe(1);
    expect(((seen[0] as { name: string }[])[0]).name).toBe('read_pod_context');
  });
});
