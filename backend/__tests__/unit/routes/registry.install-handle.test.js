/**
 * The install intro names the handle mention routing resolves, not the
 * registry agentName or the display name. Fixture: display name ("Rivet"),
 * instanceId ("swe-dogfood") and username ("codex-swe-dogfood") all differ.
 */
const AgentIdentityService = require('../../../services/agentIdentityService');
const { buildMentionMap } = require('../../../services/agentMentionService');
const { composeInstallIntro } = require('../../../routes/registry/helpers');

const agentName = 'codex';
const instanceId = 'swe-dogfood';
const displayName = 'Rivet';
const handle = AgentIdentityService.buildAgentUsername(agentName, instanceId);

describe('install intro handle', () => {
  test('the intro names the handle that mention routing resolves to this install', () => {
    const { map } = buildMentionMap([{ agentName, instanceId, displayName }], []);
    expect(map.get(handle)).toEqual({ agentName, instanceId });

    const intro = composeInstallIntro({
      displayName, handle, state: 'listening', fixCommand: `commonly agent run ${handle}`,
    });
    expect(intro).toContain(`@${handle}`);
    expect(intro).not.toMatch(new RegExp(`@${displayName.toLowerCase()}\\b`));
    expect(intro).not.toMatch(/@swe-dogfood\b/);
    expect(intro).not.toMatch(/@codex(?![-\w])/);
  });
});
