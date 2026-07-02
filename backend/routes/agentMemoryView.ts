/**
 * Authed, owner/admin-only agent MEMORY view — the private counterpart to the
 * public agent profile. Where the public profile shows only a count, this
 * returns an INDEX of the agent's memory (section headers + short snippets) so
 * an owner or admin can see what their agent actually remembers.
 *
 * Access:
 *   - admin (role === 'admin') → any agent
 *   - owner (installed this agent: AgentInstallation.installedBy === viewer) → their agent
 *   - everyone else → 403
 *
 * Returns snippets, never full raw content — "a fraction of memory". Internal
 * housekeeping sections (dedup_state, runtime_meta) are excluded.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const auth = require('../middleware/auth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentMemory = require('../models/AgentMemory');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AgentInstallation } = require('../models/AgentRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveAgentDisplayLabel } = require('../services/agentIdentityService');

interface AuthReq {
  user?: { id?: string };
  userId?: string;
  params?: { agentName?: string; instanceId?: string };
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => Res | void;
}

const getUserId = (req: AuthReq): string | undefined => req.user?.id || req.userId;
const SNIPPET = 180;
const snip = (s: unknown): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET ? `${t.slice(0, SNIPPET)}…` : t;
};

// Sections that are internal housekeeping, never shown as "memory".
const INTERNAL_SECTIONS = new Set(['dedup_state', 'runtime_meta']);

// Parse a markdown blob into an index of its `#`/`##` headers + the snippet of
// text that follows each. Falls back to one untitled note if there are no
// headers. Returns [] for empty content.
const indexMarkdown = (content: string): Array<{ header: string; snippet: string }> => {
  const text = String(content || '').trim();
  if (!text) return [];
  const lines = text.split('\n');
  const notes: Array<{ header: string; snippet: string }> = [];
  let current: { header: string; body: string[] } | null = null;
  const flush = () => {
    if (current) notes.push({ header: current.header, snippet: snip(current.body.join(' ')) });
  };
  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) {
      flush();
      current = { header: h[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else if (line.trim()) {
      // Preamble before any header → an "Overview" note.
      current = { header: 'Overview', body: [line] };
    }
  }
  flush();
  return notes.slice(0, 20);
};

const router: ReturnType<typeof express.Router> = express.Router();

// GET /api/agent-memory/:agentName/:instanceId? — owner/admin memory index.
router.get('/:agentName/:instanceId?', auth, async (req: AuthReq, res: Res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const agentName = String(req.params?.agentName || '').trim().toLowerCase();
    const instanceId = String(req.params?.instanceId || 'default').trim() || 'default';
    if (!agentName) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Access gate: admin OR owner (installed this agent).
    const viewer = await User.findById(userId).select('role').lean();
    const isAdmin = viewer?.role === 'admin';
    let role: 'admin' | 'owner' | null = isAdmin ? 'admin' : null;
    if (!isAdmin) {
      const owns = await AgentInstallation.findOne({
        agentName,
        instanceId,
        installedBy: userId,
        status: 'active',
      }).select('_id').lean();
      if (owns) role = 'owner';
    }
    if (!role) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const agentUser = await User.findOne({
      isBot: true,
      'botMetadata.agentName': agentName,
      'botMetadata.instanceId': instanceId,
    }).select('username botMetadata').lean();

    const record = await AgentMemory.findOne({ agentName, instanceId })
      .select('sections updatedAt')
      .lean();

    const sections: Array<{ key: string; label: string; kind: string; notes: unknown[] }> = [];
    let totalEntries = 0;
    const raw = ((record as Record<string, unknown>)?.sections || {}) as Record<string, unknown>;

    for (const [key, value] of Object.entries(raw)) {
      if (INTERNAL_SECTIONS.has(key)) continue;

      if (key === 'daily' && Array.isArray(value)) {
        const notes = value
          .slice(-12)
          .reverse()
          .map((d: Record<string, unknown>) => ({ header: String(d.date || ''), snippet: snip(d.content) }))
          .filter((n) => n.header || n.snippet);
        if (notes.length) { sections.push({ key, label: 'Daily journal', kind: 'log', notes }); totalEntries += notes.length; }
      } else if (key === 'cycles' && value && typeof value === 'object') {
        const entries = Array.isArray((value as Record<string, unknown>).entries)
          ? ((value as Record<string, unknown>).entries as Array<Record<string, unknown>>)
          : [];
        const notes = entries.slice(0, 8).map((e) => ({
          header: e.ts ? String(e.ts).slice(0, 10) : 'cycle',
          snippet: snip(e.content),
        }));
        if (notes.length) { sections.push({ key, label: 'Heartbeat cycles', kind: 'log', notes }); totalEntries += notes.length; }
      } else if (value && typeof value === 'object' && 'content' in (value as Record<string, unknown>)) {
        // long_term (and any future doc-shaped section) → index its headers.
        const notes = indexMarkdown(String((value as Record<string, unknown>).content || ''));
        const label = key === 'long_term' ? 'Long-term memory' : key.replace(/_/g, ' ');
        if (notes.length) { sections.push({ key, label, kind: 'doc', notes }); totalEntries += notes.length; }
      }
    }

    res.json({
      agentName,
      instanceId,
      displayName: agentUser ? resolveAgentDisplayLabel(agentUser, agentUser.username) : instanceId,
      viewerRole: role,
      updatedAt: (record as Record<string, unknown>)?.updatedAt || null,
      totalEntries,
      sections,
    });
  } catch (err) {
    console.error('[agent-memory] error:', (err as Error).message);
    res.status(500).json({ error: 'Server Error' });
  }
});

module.exports = router;
export {};
