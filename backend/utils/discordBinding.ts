// Discord's binding identity — the guild and channel a row is anchored to —
// must come from Discord, never from a request body or query string. Every
// value this module guards is interpolated into a `discord.com/api/...` URL
// carrying the INSTANCE bot token, so a caller-supplied one addresses every
// guild the bot can see, not the caller's own.
//
// Two refusals, one place, because the alternatives both fail silently:
//   · a shape check that runs after a lookup still hands the raw string to the
//     URL when the lookup misses and the handler falls through;
//   · stripping a value instead of refusing it returns 200 for a write the
//     caller did not get, and the UI then reports a binding that does not
//     exist. Refuse the request; never "ignore" the field.
//
// Discord ids are snowflakes: 17-20 decimal digits. A JavaScript number cannot
// carry one exactly (they exceed 2^53), so the value must arrive as a string —
// accepting a number would silently round it into a different guild.

export const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

export const isDiscordSnowflake = (value: unknown): boolean => (
  typeof value === 'string' && DISCORD_SNOWFLAKE.test(value)
);

// A field the caller actually supplied. An absent field is not a request for
// anything, so it is left to the manifest's required-field check rather than
// refused here.
//
// This must be the EXACT COMPLEMENT of that check — `missingFrom`
// (`routes/integrations.ts`) counts `undefined`/`null`/`''` as missing, and
// nothing else. Two tests that are merely similar leave a third state, and
// it is the dangerous one: a value that is not "missing" to the manifest, so the
// write proceeds, and not "supplied" to this guard, so its shape is never
// judged — and it then reaches the `discord.com/api/...` URL unjudged. A
// stringify-and-trim test does exactly that for `'  '` (and for `[]`, which
// stringifies to the empty string). Measured at the previous head: a
// whitespace-only id, an array id and a whitespace-only token each stored the
// row and made the outbound call.
//
// It stays a VALUE test, not a key-presence test, and that is load-bearing on
// the live path: the consent callback posts `botToken: ''`
// (`DiscordCallback.tsx:100`) alongside real ids, and `getMissingCallerFields`
// counts `''` as missing, so a caller-supplied `''` still fails that check while
// a key-presence test here would refuse every real bind.
export const isSupplied = (value: unknown): boolean => (
  value !== undefined && value !== null && value !== ''
);

export const invalidDiscordIdError = (field: string) => ({
  message: `${field} must be a Discord snowflake id (17-20 digits)`,
  code: 'invalid_discord_id',
  field,
});

// Server-owned: the instance credential is resolved from the environment on
// every read (`resolveEffectiveConfig`), so a stored copy is never needed and a
// request-supplied one would replace the instance's own token with the
// caller's. The refusal is Discord-scoped and runs BEFORE the shared strip on
// both routes, so a supplied Discord token is a 400 rather than a silent 200;
// `botToken` is also in `SERVER_OWNED_CONFIG_KEYS`
// (`utils/serverOwnedConfigKeys.ts`), which is what drops it for every other
// type. An earlier revision of this comment argued the token could not join that
// list because stripping it would leave a manifest-required field with no value
// to inject — false twice over by 2026-09-25: #1896 had already applied the strip
// to Slack, and TASK-140 removed the manifest requirement it named.
export const serverOwnedConfigError = (field: string) => ({
  message: `${field} is server-owned and cannot be set from a request body`,
  code: 'server_owned_config_key',
  field,
});

export const DISCORD_BINDING_ID_FIELDS = ['serverId', 'channelId'] as const;

// Returns the first binding-identity field the request supplied in a shape
// Discord would not accept, or null.
//
// `isSupplied`, not `field in config`: an explicitly empty id is a missing id,
// and the manifest's required-field check already answers for that with its own
// 400. Claiming it here would replace that message with a shape refusal for a
// value the caller never really supplied — and the token on the same payload is
// empty by design.
export const malformedDiscordBindingField = (
  config: Record<string, unknown> | null | undefined,
): string | null => {
  if (!config) return null;
  const bad = DISCORD_BINDING_ID_FIELDS.find(
    (field) => isSupplied(config[field]) && !isDiscordSnowflake(config[field]),
  );
  return bad || null;
};
