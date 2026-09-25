/**
 * TASK-140 — the PUBLISHED contract must name only what a caller can supply.
 *
 * `GET /api/integrations/catalog` returns `manifest.requiredConfig` (and the
 * `configSchema` built from the same array) verbatim, while
 * `SERVER_OWNED_CONFIG_KEYS` deletes those keys from every request body. Discord
 * published `botToken` and then refused it with `server_owned_config_key`, so a
 * client that followed the catalog could not create what the catalog described —
 * one question, two answers, because the two lists lived in different files.
 *
 * The invariants below are what keeps them one list:
 *   1. no `requiredConfig` entry is server-owned — the published lie;
 *   2. every `serverOwnedConfig` entry IS server-owned — the mirror defect, a
 *      caller-suppliable field hidden from the caller;
 *   3. the catalog payload carries no server-owned name in `requiredConfig`,
 *      `configSchema.required` or `configSchema.properties` (the schema is part
 *      of the same response, so trimming one list and not the other would leave
 *      the defect in place);
 *   4. the SERVER still validates the union — the split must not silently drop
 *      the half a caller cannot see.
 */
const { manifests, manifestForValidation } = require('../../../integrations/manifests');
const { getManifestEntries } = require('../../../integrations/catalog');
const { SERVER_OWNED_CONFIG_KEYS } = require('../../../utils/serverOwnedConfigKeys');

const serverOwned = new Set(SERVER_OWNED_CONFIG_KEYS);
const all = Object.values(manifests);

const schemaNames = (schema) => [
  ...((schema && Array.isArray(schema.required)) ? schema.required : []),
  ...Object.keys((schema && schema.properties) || {}),
];

describe('manifest caller contract (TASK-140)', () => {
  it('publishes no server-owned key in any requiredConfig', () => {
    const offenders = all.flatMap((manifest) => manifest.requiredConfig
      .filter((key) => serverOwned.has(key))
      .map((key) => `${manifest.id}.${key}`));

    expect(offenders).toEqual([]);
  });

  it('declares every serverOwnedConfig entry in the shared server-owned list', () => {
    const unknown = all.flatMap((manifest) => manifest.serverOwnedConfig
      .filter((key) => !serverOwned.has(key))
      .map((key) => `${manifest.id}.${key}`));

    expect(unknown).toEqual([]);
  });

  it('publishes no server-owned key anywhere in the catalog payload', () => {
    const offenders = getManifestEntries().flatMap((entry) => [
      ...entry.requiredConfig,
      ...schemaNames(entry.configSchema),
    ].filter((key) => serverOwned.has(key)).map((key) => `${entry.id}.${key}`));

    expect(offenders).toEqual([]);
  });

  it('publishes exactly the caller-supplied fields for discord and slack', () => {
    const published = Object.fromEntries(getManifestEntries().map((e) => [e.id, e.requiredConfig]));

    // Discord: the consent callback sends the two ids and an empty `botToken`
    // (`DiscordCallback.tsx`), and the route refuses the token outright.
    expect(published.discord).toEqual(['serverId', 'channelId']);
    // Slack: the caller may send the legacy channel shape; the token is the
    // instance credential, and the opaque ref is written by the OAuth bind.
    expect(published.slack).toEqual(['signingSecret', 'channelId']);
  });

  it('still validates the server-owned half through the derived manifest', () => {
    expect(manifestForValidation(manifests.discord).requiredConfig)
      .toEqual(['serverId', 'channelId', 'botToken']);
    expect(manifestForValidation(manifests.slack).requiredConfig)
      .toEqual(['signingSecret', 'channelId', 'botTokenRef']);
    expect(manifestForValidation(manifests.telegram).requiredConfig).toEqual(['chatId']);
  });

  it('publishes nothing for telegram, whose binding is the connect code', () => {
    const published = Object.fromEntries(getManifestEntries().map((e) => [e.id, e.requiredConfig]));

    expect(published.telegram).toEqual([]);
  });

  it('leaves the published list of every other connector untouched', () => {
    const published = Object.fromEntries(getManifestEntries().map((e) => [e.id, e.requiredConfig]));

    expect(published.groupme).toEqual(['botId', 'groupId']);
    expect(published.x).toEqual(['accessToken', 'username']);
    expect(published.instagram).toEqual(['accessToken', 'igUserId']);
  });
});
