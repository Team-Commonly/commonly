// Display-label resolution for agent User rows. Load-bearing for any
// surface that renders agent identity (agent-dm pod names, sidebar member
// list, system "DM started" announcement). Bug PR: agent-dm pods were
// rendering as "openclaw ↔ openclaw" because the runtime-leaning agentName
// was used as the fallback instead of botMetadata.displayName.

jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../models/User', () => ({}));

const { resolveAgentDisplayLabel } = require('../../../services/agentIdentityService');

describe('resolveAgentDisplayLabel', () => {
  it('returns botMetadata.displayName when set (most-preferred)', () => {
    const user = {
      username: 'openclaw-pixel',
      botMetadata: { displayName: 'Pixel', agentName: 'openclaw', instanceId: 'pixel' },
    };
    expect(resolveAgentDisplayLabel(user)).toBe('Pixel');
  });

  it('falls back to instanceId when displayName is missing — never to agentName runtime', () => {
    // The exact bug: agentName='openclaw' is the runtime, instanceId is the
    // identity. Falling back to instanceId beats falling back to agentName.
    const user = {
      username: 'openclaw-aria',
      botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
    };
    expect(resolveAgentDisplayLabel(user)).toBe('aria');
  });

  it('skips an instanceId of "default" (no identity in it) and uses username', () => {
    const user = {
      username: 'commonly-bot',
      botMetadata: { agentName: 'commonly-bot', instanceId: 'default' },
    };
    expect(resolveAgentDisplayLabel(user)).toBe('commonly-bot');
  });

  it('uses username when botMetadata is empty (humans)', () => {
    const user = { username: 'sam', botMetadata: undefined };
    expect(resolveAgentDisplayLabel(user)).toBe('sam');
  });

  it('uses the supplied fallback when even username is missing', () => {
    const user = {};
    expect(resolveAgentDisplayLabel(user, 'unknown-agent')).toBe('unknown-agent');
  });

  it('returns the fallback for null user (resolved-by-alias before User load)', () => {
    expect(resolveAgentDisplayLabel(null, 'aria')).toBe('aria');
  });

  it('treats a whitespace-only displayName as absent', () => {
    const user = {
      username: 'openclaw-pixel',
      botMetadata: { displayName: '   ', agentName: 'openclaw', instanceId: 'pixel' },
    };
    expect(resolveAgentDisplayLabel(user)).toBe('pixel');
  });

  // Leak-pattern detection — defensive guard for historical contamination.
  // Some path (likely a DM-creation pre-2026-05-04) wrote
  // `botMetadata.displayName = "openclaw (nova)"` (i.e. literally
  // `${agentName} (${instanceId})`), and that string then surfaced in pod
  // names + the §9 inline DM frame. The resolver now detects + rejects this
  // shape and falls through to instanceId.
  describe('leak-pattern detection', () => {
    it('rejects displayName === "<agentName> (<instanceId>)" and falls through to instanceId', () => {
      const user = {
        username: 'openclaw-nova',
        botMetadata: { displayName: 'openclaw (nova)', agentName: 'openclaw', instanceId: 'nova' },
      };
      expect(resolveAgentDisplayLabel(user)).toBe('nova');
    });

    it('rejects bare displayName === agentName (e.g. just "openclaw")', () => {
      const user = {
        username: 'openclaw-aria',
        botMetadata: { displayName: 'openclaw', agentName: 'openclaw', instanceId: 'aria' },
      };
      expect(resolveAgentDisplayLabel(user)).toBe('aria');
    });

    it('is case-insensitive — "OpenClaw (Pixel)" still rejected', () => {
      const user = {
        username: 'openclaw-pixel',
        botMetadata: { displayName: 'OpenClaw (Pixel)', agentName: 'openclaw', instanceId: 'pixel' },
      };
      expect(resolveAgentDisplayLabel(user)).toBe('pixel');
    });

    it('keeps a curated displayName that happens to share the agentName prefix', () => {
      // "Strategist (Aria)" is curated — agentName prefix is incidental, not
      // the literal pattern. Keep it.
      const user = {
        username: 'openclaw-aria',
        botMetadata: { displayName: 'Strategist (Aria)', agentName: 'openclaw', instanceId: 'aria' },
      };
      expect(resolveAgentDisplayLabel(user)).toBe('Strategist (Aria)');
    });

    it('keeps a normal curated label unchanged', () => {
      const user = {
        username: 'openclaw-nova',
        botMetadata: { displayName: 'Nova', agentName: 'openclaw', instanceId: 'nova' },
      };
      expect(resolveAgentDisplayLabel(user)).toBe('Nova');
    });
  });
});
