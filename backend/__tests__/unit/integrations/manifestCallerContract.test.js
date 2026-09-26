// TASK-140, item 1. `manifest.requiredConfig` is two things at once:
//
//   · the COMPLETENESS PREDICATE that sets a row's `status`
//     (`getMissingRequiredFields` → `isManifestComplete`, `routes/integrations.ts`), which
//     names server-owned keys BY DESIGN — a bind writes `chatId`/`botTokenRef`, the
//     environment supplies Discord's `botToken`; and
//   · minus `SERVER_OWNED_CONFIG_KEYS`, the contract published by
//     `GET /api/integrations/catalog`.
//
// So these tests assert on the PUBLISHED output (`getManifestEntries`, the catalog's own
// function) for the caller-facing half, and on the predicate for the status half. The
// failure they are here to catch is a "cleanup" that deletes the second half: an empty
// predicate reads as complete (`getMissingRequiredFields` returns `[]`), and a row would
// then be created `connected` before anything bound it (wren, 74255).
const { manifests } = require('../../../integrations/manifests');
const { getManifestEntries, buildCatalogEntries } = require('../../../integrations/catalog');
const { SERVER_OWNED_CONFIG_KEYS } = require('../../../utils/serverOwnedConfigKeys');

const serverOwned = new Set(SERVER_OWNED_CONFIG_KEYS);
const published = (id) => getManifestEntries().find((entry) => entry.id === id);
const predicate = (id) => manifests[id].requiredConfig;

describe('manifest contract (TASK-140)', () => {
  it('publishes no server-owned key in any requiredConfig', () => {
    const offenders = getManifestEntries()
      .flatMap((entry) => entry.requiredConfig.map((key) => `${entry.id}.${key}`))
      .filter((key) => serverOwned.has(key.split('.')[1]));

    expect(offenders).toEqual([]);
  });

  it('publishes no server-owned key in a schema property or in schema.required', () => {
    const offenders = getManifestEntries().flatMap((entry) => {
      const schema = entry.configSchema || {};
      const keys = [ ...Object.keys(schema.properties || {}), ...(schema.required || []) ];
      return keys.filter((key) => serverOwned.has(key)).map((key) => `${entry.id}.${key}`);
    });

    expect(offenders).toEqual([]);
  });

  it('publishes exactly what a caller may send, per connector', () => {
    expect(published('discord').requiredConfig).toEqual(['serverId', 'channelId']);
    // Slack binds over OAuth and Telegram binds by connect code: neither has a
    // caller-supplied field left, so both publish an empty list.
    expect(published('slack').requiredConfig).toEqual([]);
    expect(published('telegram').requiredConfig).toEqual([]);
    expect(published('groupme').requiredConfig).toEqual(['botId', 'groupId']);
    expect(published('x').requiredConfig).toEqual(['accessToken', 'username']);
    expect(published('instagram').requiredConfig).toEqual(['accessToken', 'igUserId']);
  });

  it('keeps every published requirement inside the published schema', () => {
    // `configSchema` may declare more than the predicate (x and instagram list
    // optional extras), but a published requirement that is not in the schema
    // would be a field the caller cannot see how to fill.
    getManifestEntries().forEach((entry) => {
      const declared = (entry.configSchema || {}).required || [];
      entry.requiredConfig.forEach((key) => {
        expect({ id: entry.id, key, declared }).toEqual({ id: entry.id, key, declared: expect.arrayContaining([ key ]) });
      });
    });
  });

  it('keeps the predicate naming the keys only the server writes', () => {
    // The point of the split: the row is not configured until these exist, and
    // the published list above says nothing about them.
    expect(predicate('discord')).toContain('botToken');
    expect(predicate('slack')).toContain('botTokenRef');
    expect(predicate('slack')).toContain('chatId');
    expect(predicate('telegram')).toContain('chatId');
  });

  it('names in the slack predicate what the bind writes, and no retired field', () => {
    // The bind (`routes/installables.ts`, Slack OAuth commit) writes `chatId` and
    // `botTokenRef`. The predicate used to name `botToken` (retired by TASK-124)
    // and `channelId` (no Slack writer), which is why a bound row failed its own
    // completeness check (wren, 74256).
    expect(predicate('slack')).toEqual(['botTokenRef', 'chatId']);
    expect(predicate('slack')).not.toContain('botToken');
    expect(predicate('slack')).not.toContain('channelId');
  });

  it('keeps every predicate non-empty, so nothing reads as complete before it is bound', () => {
    Object.entries(manifests).forEach(([ , manifest ]) => {
      expect(manifest.requiredConfig.length).toBeGreaterThan(0);
    });
  });

  it('filters the same way through buildCatalogEntries', async () => {
    const entries = await buildCatalogEntries({});
    const discord = entries.find((entry) => entry.id === 'discord');
    const slack = entries.find((entry) => entry.id === 'slack');

    expect(discord.requiredConfig).toEqual(['serverId', 'channelId']);
    expect(slack.requiredConfig).toEqual([]);
    expect(slack.configSchema.required).toEqual([]);
    expect(slack.configSchema.properties).toEqual({});
  });
});
