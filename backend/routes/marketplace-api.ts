const { randomUUID } = require('crypto');
const express = require('express');
const auth = require('../middleware/auth');
const { platformIpRateLimit } = require('../middleware/platformRateLimit');
const InstallableModel = require('../models/Installable');
const { REGISTRY_BACKFILL_ORIGIN } = require('../services/installable/registryBackfillOrigin');
const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');
const SchedulerHeartbeatLease = require('../models/SchedulerHeartbeatLease');
const SystemSetting = require('../models/SystemSetting');
const { validateMcpComponent } = require('../utils/pluginManifestParser');

const router = express.Router();

const NAMESPACE_RE = /^@[a-z0-9-]+\/[a-z0-9-]+$/;

const resolveUsername = (req: any): string | null => req.user?.username || null;

// Deny by default. A row the AgentRegistry bridge backfilled is not a
// listing, so every route here reads and writes through `listings`, which
// cannot see one. Only the two named functions after it touch the model, and
// a test pins that (marketplace.backfill.test.js).
const listingFilter = (filter: any = {}) => ({ ...filter, origin: { $ne: REGISTRY_BACKFILL_ORIGIN } });
const listings = {
  find: (filter: any) => InstallableModel.find(listingFilter(filter)),
  findOne: (filter: any) => InstallableModel.findOne(listingFilter(filter)),
  countDocuments: (filter: any) => InstallableModel.countDocuments(listingFilter(filter)),
  updateOne: (filter: any, update: any, opts?: any) => InstallableModel.updateOne(listingFilter(filter), update, opts),
  deleteOne: (filter: any) => InstallableModel.deleteOne(listingFilter(filter)),
  create: (doc: any) => InstallableModel.create(doc),
};

// The one deliberate exception: publish takes a backfilled row over. The
// namespace check has already decided who may publish the id.
const findBackfillForTakeover = (installableId: string) => InstallableModel.findOne({
  installableId, origin: REGISTRY_BACKFILL_ORIGIN,
});

// A new id must be free of every row, marked ones included; answers only yes/no.
const installableIdTaken = async (installableId: string): Promise<boolean> => (
  Boolean(await InstallableModel.findOne({ installableId }))
);

// Publish and fork write AgentRegistry, then Installable. Without an exclusive
// claim, two requests for one id both pass admission, the last AgentRegistry
// write wins, and Installable keeps the other request's doc. The claim reuses
// the scheduler lease model rather than a new one: same compare-and-set on a
// fixed _id, same TTL cleanup, no new collection or index. The prefix keeps
// these ids apart from the scheduler's fixed ones.
const INSTALLABLE_CLAIM_MS = 30_000;
const installableClaimId = (installableId: string) => `installable-claim:${installableId}`;

// Returns the owner token, or null while another live request holds the id.
// An expired claim (its holder crashed or ran past 30s) is taken over.
const acquireInstallableClaim = async (installableId: string): Promise<string | null> => {
  const ownerId = randomUUID();
  const now = new Date();
  try {
    await SchedulerHeartbeatLease.findOneAndUpdate(
      { _id: installableClaimId(installableId), expiresAt: { $lte: now } },
      { $set: { ownerId, expiresAt: new Date(now.getTime() + INSTALLABLE_CLAIM_MS) } },
      { upsert: true, new: true },
    );
    return ownerId;
  } catch (error) {
    if ((error as any)?.code === 11000) return null;
    throw error;
  }
};

// Re-checks, right before a write, that this request still holds the id, and
// extends the claim. A holder that stalled past expiry gets false and must not
// write: another request may have taken the id over and committed since. A
// stall inside a write, after this check, is caught by the fencing token below.
const confirmInstallableClaim = async (installableId: string, ownerId: string): Promise<boolean> => {
  const now = new Date();
  const claim = await SchedulerHeartbeatLease.findOneAndUpdate(
    { _id: installableClaimId(installableId), ownerId, expiresAt: { $gt: now } },
    { $set: { expiresAt: new Date(now.getTime() + INSTALLABLE_CLAIM_MS) } },
    { new: true },
  );
  return Boolean(claim);
};

const CLAIM_RELEASE_ATTEMPTS = 3;
const CLAIM_RELEASE_WAIT_WARNING = 'The installableId claim could not be released; '
  + 'wait about 30 seconds before retrying, when it expires.';

// Deletes only this request's claim document, retrying a few times. Returns
// whether the delete went through (deletedCount 0 counts: the claim is gone).
// On false the TTL expiry still frees the id.
const releaseInstallableClaim = async (installableId: string, ownerId: string): Promise<boolean> => {
  for (let attempt = 1; attempt <= CLAIM_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await SchedulerHeartbeatLease.deleteOne({ _id: installableClaimId(installableId), ownerId });
      return true;
    } catch (error) {
      console.warn(
        `[marketplace] installableId claim release failed (attempt ${attempt}):`,
        (error as any).message,
      );
      if (attempt < CLAIM_RELEASE_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 10 * attempt); });
      }
    }
  }
  return false;
};

const claimExpired = (res: any) => res.status(409).json({
  error: 'installableId claim expired before the write, retry',
  code: 'installable_id_busy',
});

// Fencing token. The claim is a lease, so a holder can pass its confirm, stall
// inside the write that follows (a slow round trip, a GC pause) past expiry,
// and have that write land after another request took the id over and
// committed both rows. So every request draws a token once it holds the
// claim, and every AgentRegistry and Installable write it makes carries
// "stored token <= mine" in its own filter and stamps its token on the row in
// that same write. A later holder's token is higher, so once it has written a
// row, the stale write to that row matches nothing and the stale holder
// answers 409.
//
// The token comes from one counter, `$inc` on a SystemSetting row, not from
// the claim document: that one is deleted on release and by the TTL monitor
// after expiry, so a count kept on it would restart. One counter shared by
// every id is still monotonic per id, needs no new model (ADR-034 D4) and no
// clock. It is drawn after the claim is acquired and before the first
// confirm, so tokens follow claim order: A's draw precedes A's confirm, which
// precedes A's expiry, B's acquire and B's draw. A holder that stalls between
// acquire and draw may draw above its successor, but then fails the confirm
// that precedes every write and writes nothing. (Drawn before the acquire, a
// request that stalled there would acquire later holding a lower token than
// the holder it followed, whose in-flight write would then overwrite it.) A row
// with no token (every row written before the fence) counts as lowest, hence
// `$not: { $gt }` rather than `$lte`, which a missing field fails.
const CLAIM_FENCE_KEY = 'marketplace.installableClaimFence';

class InstallableClaimFenced extends Error {}

const nextClaimFence = async (): Promise<number> => {
  const draw = () => SystemSetting.findOneAndUpdate(
    { key: CLAIM_FENCE_KEY },
    { $inc: { 'value.seq': 1 } },
    // The schema default for `value` would conflict with the $inc on insert.
    { upsert: true, new: true, setDefaultsOnInsert: false },
  ).lean();
  let row;
  try {
    row = await draw();
  } catch (error) {
    // Two first-ever upserts race on the unique key; the retry updates.
    if ((error as any)?.code !== 11000) throw error;
    row = await draw();
  }
  return row.value.seq;
};

const notNewerThan = (fence: number) => ({ claimFence: { $not: { $gt: fence } } });

// A write was refused by a newer token. If the counter were ever reset (its
// settings row lost), stored tokens would sit above every new one and refuse
// every write for good; raising the counter to the stored token lets the
// client's retry draw a higher one. In a real race it is a no-op.
const fencedBy = async (stored: unknown) => {
  if (typeof stored === 'number') {
    try {
      await SystemSetting.updateOne({ key: CLAIM_FENCE_KEY }, { $max: { 'value.seq': stored } });
    } catch (error) {
      console.warn('[marketplace] claim fence counter repair failed:', (error as any).message);
    }
  }
  return new InstallableClaimFenced('installableId taken over by a newer claim');
};

// What a fenced doc.save() throws when its filter matches nothing. VersionError
// comes instead when the save also checks the version key (an array was set).
const SAVE_MISSES = new Set(['DocumentNotFoundError', 'VersionError']);
const TAKEOVER_ATTEMPTS = 3;

// The create path's Installable write onto a row that already exists. Two
// kinds qualify: a backfilled row, and one an older holder wrote after this
// request's admission check (admission found no listing, and only a claim
// holder writes one). Either is replaced whole by the publish or fork doc,
// which clears the mark, under the fence; a row a newer holder wrote refuses
// it. A save that missed because an older holder's write changed the row
// under it re-reads and tries again. Returns null when there is no row (the
// caller creates). Only Installable is written; identity tables are untouched.
const takeOverRow = async (installableId: string, publishDoc: any, userId: any, fence: number) => {
  for (let attempt = 1; attempt <= TAKEOVER_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const doc = (await findBackfillForTakeover(installableId)) || (await listings.findOne({ installableId }));
    if (!doc) return null;
    // eslint-disable-next-line no-await-in-loop
    if (typeof doc.claimFence === 'number' && doc.claimFence > fence) throw await fencedBy(doc.claimFence);
    doc.overwrite({
      ...publishDoc, owner: userId, createdAt: doc.createdAt, claimFence: fence,
    });
    // Mongoose adds `$where` to the filter of the update save() sends.
    doc.$where = notNewerThan(fence);
    try {
      // eslint-disable-next-line no-await-in-loop
      return await doc.save();
    } catch (error) {
      if (!SAVE_MISSES.has((error as any)?.name)) throw error;
    }
  }
  throw new Error('installableId row kept changing during takeover');
};

// The fields a version publish sets, which are also all the AgentRegistry row
// is derived from. The update path writes every one, so an older holder's
// write that landed first is replaced on all of them and the two rows agree.
// Stats and the rest stay with their own writers.
const MANIFEST_FIELDS = [
  'name', 'description', 'version', 'versions', 'components', 'requires',
  'readme', 'marketplace', 'publisher', 'status',
];

// The update path's Installable write. A conditional updateOne, not save():
// save() puts the version key in its filter when an array changed, so an
// older holder's write that landed first would make this newer one fail.
const updateListingFenced = async (existing: any, fence: number) => {
  const current = existing.toObject();
  const $set: any = { claimFence: fence };
  MANIFEST_FIELDS.forEach((field) => {
    if (current[field] !== undefined) $set[field] = current[field];
  });
  const result = await listings.updateOne(
    { installableId: existing.installableId, ...notNewerThan(fence) },
    { $set },
    { runValidators: true },
  );
  if (!result.matchedCount) {
    const row = await listings.findOne({ installableId: existing.installableId }).lean();
    throw await fencedBy(row?.claimFence);
  }
};

// Also run before a drift-warning 201, where the Installable write failed: a
// missing row is not a newer token, so it alone never reads as superseded.
// After both writes landed: did a newer holder take the id over? Not merely
// "did my claim lapse": a slow holder with no competitor has won, and a 409
// would leave a fork uncounted and its retry told the id is taken. Superseded
// means a row now carries a newer token (the newer holder already wrote), or
// another request holds the claim document. Every acquire after ours rewrites
// that document with its own owner, so a different owner is a later holder,
// one that will overwrite our rows once it writes; it may not have yet.
const supersededAfterWrites = async (installableId: string, ownerId: string, fence: number) => {
  const [ar, row, claim] = await Promise.all([
    AgentRegistry.findOne({ agentName: installableId }, 'claimFence'),
    listings.findOne({ installableId }),
    SchedulerHeartbeatLease.findOne({ _id: installableClaimId(installableId) }),
  ]);
  const newer = (doc: any) => typeof doc?.claimFence === 'number' && doc.claimFence > fence;
  return newer(ar) || newer(row) || Boolean(claim && claim.ownerId !== ownerId);
};

// Runs `work` (admission check included) while holding the id, or answers 409.
// `work` gets `confirm`, which it calls immediately before each write; `fence`,
// which each write carries; and `superseded`, which it checks after both writes
// before answering success. A write the fence refused answers 409 too.
const withInstallableClaim = async (
  res: any,
  installableId: string,
  work: (confirm: () => Promise<boolean>, fence: number, superseded: () => Promise<boolean>) => Promise<any>,
) => {
  const ownerId = await acquireInstallableClaim(installableId);
  if (!ownerId) {
    return res.status(409).json({
      error: 'installableId is being published by another request, retry shortly',
      code: 'installable_id_busy',
    });
  }
  // Release before the answer goes out: a client that retries as soon as it
  // reads it (the drift warning asks it to) must find the id free, not busy.
  let releasing: Promise<boolean> | null = null;
  const release = () => {
    releasing ??= releaseInstallableClaim(installableId, ownerId);
    return releasing;
  };
  const originalJson = res.json;
  res.json = (body: any) => {
    release()
      .then((released) => {
        // A client told to retry would hit the leftover claim; say how long.
        const out = !released && Array.isArray(body?.warnings)
          ? { ...body, warnings: [...body.warnings, CLAIM_RELEASE_WAIT_WARNING] }
          : body;
        originalJson.call(res, out);
      })
      // Nothing awaits this chain; a throwing send must not become an
      // unhandled rejection that takes the process down.
      .catch((error) => console.error('[marketplace] response send failed: %s', (error as Error)?.message));
    return res;
  };
  try {
    // After the acquire, before the first confirm: see the fencing-token note.
    const fence = await nextClaimFence();
    return await work(
      () => confirmInstallableClaim(installableId, ownerId),
      fence,
      () => supersededAfterWrites(installableId, ownerId, fence),
    );
  } catch (error) {
    if (error instanceof InstallableClaimFenced) return claimExpired(res);
    throw error;
  } finally {
    await release();
    res.json = originalJson;
  }
};

const validateNamespace = (installableId: string, username: string) => {
  if (!NAMESPACE_RE.test(installableId)) {
    return 'installableId must match @<username>/<name> for user manifests';
  }
  const scope = installableId.split('/')[0].slice(1);
  if (scope !== username.toLowerCase()) {
    return 'Namespace does not match your username';
  }
  return null;
};

// Component validation is a persistence boundary (PR #215/#230): every
// component is checked before it reaches Mongo, and MCP components are passed
// through the parser's normalizer so publish, update and fork share one row
// shape. The generic checks below cover component types and widget fields;
// parser-owned MCP rules cover source, transport, argv and variables.
//
// This matters more than "an unused field is sloppy". Nothing renders a widget
// today, so stored rows are inert — but they are inert only until a renderer
// ships, at which point every `widgetUrl` already in the catalog goes live at
// once. Validation has to land before the feature, not with it. It is cheapest
// now, when the published catalog is empty and there is nothing to backfill.
const COMPONENT_TYPES = [
  'agent',
  'slash-command',
  'event-handler',
  'scheduled-job',
  'widget',
  'webhook',
  'data-schema',
  'skill',
  'mcp-server',
];

// The five `Schema.Types.Mixed` fields on ComponentSchema. Mixed accepts any
// JSON of any size, and at 50 components per manifest that is an unbounded
// write reachable by anyone who can publish — a larger surface than the URL
// and independent of it, so a widgetUrl allowlist alone would not touch it.
const MIXED_COMPONENT_FIELDS = [
  'widgetConfigSchema',
  'schemaFields',
  'skillExamples',
  'variables',
  'metadata',
];
const MAX_MIXED_FIELD_BYTES = 16 * 1024;

const MAX_COMPONENTS = 50;
const MAX_WIDGET_URL_LENGTH = 2048;
const MCP_COMPONENT_FIELDS = ['transport', 'source', 'command', 'url', 'variables', 'enabledTools'];

// Scheme allowlist rather than a denylist: `javascript:` and `data:` are the
// two that turn a stored string into script execution the moment something
// renders it, but enumerating what to block is the losing side of that
// argument. http/https are what a widget host can legitimately be.
const WIDGET_URL_SCHEMES = ['http:', 'https:'];

const normalizeComponents = (components: any) => {
  if (components === undefined || components === null) return { components, error: null };
  if (!Array.isArray(components)) return { components, error: 'components must be an array' };
  if (components.length > MAX_COMPONENTS) {
    return { components, error: `Maximum ${MAX_COMPONENTS} components per manifest` };
  }

  const normalizedComponents = components.slice();
  for (let i = 0; i < normalizedComponents.length; i += 1) {
    const component = normalizedComponents[i];
    const at = `components[${i}]`;

    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      return { components, error: `${at} must be an object` };
    }
    if (typeof component.name !== 'string' || !component.name.trim()) {
      return { components, error: `${at}.name is required` };
    }
    if (component.name.length > 100) {
      return { components, error: `${at}.name must be 100 characters or fewer` };
    }
    if (!COMPONENT_TYPES.includes(component.type)) {
      return { components, error: `${at}.type must be one of: ${COMPONENT_TYPES.join(', ')}` };
    }
    if (component.description !== undefined) {
      if (typeof component.description !== 'string') {
        return { components, error: `${at}.description must be a string` };
      }
      if (component.description.length > 500) {
        return { components, error: `${at}.description must be 500 characters or fewer` };
      }
    }

    if (component.type === 'mcp-server') {
      const validation = validateMcpComponent(component, at);
      if (validation.errors.length) {
        const firstError = validation.errors[0];
        return { components, error: `${firstError.field}: ${firstError.message}` };
      }
      normalizedComponents[i] = validation.component;
    } else {
      const mcpField = MCP_COMPONENT_FIELDS.find((field) => component[field] !== undefined);
      if (mcpField) {
        return { components, error: `${at}.${mcpField} is only valid for mcp-server components` };
      }
    }

    if (component.widgetUrl !== undefined) {
      if (typeof component.widgetUrl !== 'string') {
        return { components, error: `${at}.widgetUrl must be a string` };
      }
      if (component.widgetUrl.length > MAX_WIDGET_URL_LENGTH) {
        return { components, error: `${at}.widgetUrl must be ${MAX_WIDGET_URL_LENGTH} characters or fewer` };
      }
      let parsed;
      try {
        parsed = new URL(component.widgetUrl);
      } catch {
        return { components, error: `${at}.widgetUrl must be an absolute URL` };
      }
      if (!WIDGET_URL_SCHEMES.includes(parsed.protocol)) {
        return { components, error: `${at}.widgetUrl must use one of: ${WIDGET_URL_SCHEMES.join(', ')}` };
      }
    }

    for (const field of MIXED_COMPONENT_FIELDS) {
      if (component[field] === undefined) continue;
      let serialized;
      try {
        serialized = JSON.stringify(component[field]);
      } catch {
        // A body that survived JSON.parse cannot be cyclic, so reaching here
        // means something else (a getter, a BigInt) — reject rather than store
        // a value we could not measure.
        return { components, error: `${at}.${field} could not be serialized` };
      }
      if (serialized !== undefined && Buffer.byteLength(serialized, 'utf8') > MAX_MIXED_FIELD_BYTES) {
        return { components, error: `${at}.${field} must be ${MAX_MIXED_FIELD_BYTES} bytes or fewer when serialized` };
      }
    }
  }

  return { components: normalizedComponents, error: null };
};

const RUNTIME_MAP: Record<string, string> = {
  native: 'standalone',
  internal: 'standalone',
  'managed-agents': 'commonly-hosted',
  webhook: 'standalone',
  'claude-code': 'standalone',
  moltbot: 'standalone',
  remote: 'standalone',
  'local-cli': 'standalone', // ADR-005 local CLI wrapper driver
};

// With `fence` (publish and fork, under the claim) the upsert matches only a
// row whose token is not newer, and stamps the token. Against a newer row the
// upsert tries an insert, which the unique agentName index refuses (E11000):
// that is the fence, not an error. E11000 against an older or tokenless row
// is two upserts of a new name colliding, and the retry matches it.
const syncToAgentRegistry = async (
  installable: any,
  action: 'publish' | 'unpublish' | 'delete' | 'deprecate',
  fence?: number,
) => {
  const agentName = installable.installableId;

  if (action === 'delete') {
    await AgentRegistry.deleteOne({ agentName });
    return;
  }

  if (action === 'unpublish') {
    await AgentRegistry.updateOne({ agentName }, { status: 'unpublished' });
    return;
  }

  const agentComponent = (installable.components || []).find((c: any) => c.type === 'agent');
  const runtimeType = agentComponent?.runtime
    ? (RUNTIME_MAP[agentComponent.runtime] || 'standalone')
    : 'standalone';

  const capabilities = (installable.components || []).map((c: any) => ({
    name: c.name,
    description: c.description || c.name,
  }));

  const arPayload: any = {
    agentName,
    displayName: installable.name,
    description: installable.description || '',
    readme: installable.readme,
    manifest: {
      name: agentName,
      version: installable.version,
      description: installable.description || '',
      capabilities,
      context: { required: installable.requires || [], optional: [] },
      runtime: { type: runtimeType, connection: 'rest' },
    },
    latestVersion: installable.version,
    versions: (installable.versions || []).map((v: any) => ({
      version: v.version,
      publishedAt: v.publishedAt,
      deprecated: v.deprecated,
      deprecationReason: v.deprecationReason,
    })),
    registry: 'commonly-community',
    publisher: installable.publisher,
    categories: installable.marketplace?.category ? [installable.marketplace.category] : [],
    tags: installable.marketplace?.tags || [],
    status: installable.status,
  };

  if (fence === undefined) {
    await AgentRegistry.findOneAndUpdate({ agentName }, { $set: arPayload }, { upsert: true, new: true });
    return;
  }
  arPayload.claimFence = fence;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await AgentRegistry.findOneAndUpdate(
        { agentName, ...notNewerThan(fence) },
        { $set: arPayload },
        { upsert: true, new: true },
      );
      return;
    } catch (error) {
      if ((error as any)?.code !== 11000 || attempt === 2) throw error;
      // eslint-disable-next-line no-await-in-loop
      const stored = (await AgentRegistry.findOne({ agentName }).select('claimFence').lean())?.claimFence;
      // eslint-disable-next-line no-await-in-loop
      if (typeof stored === 'number' && stored > fence) throw await fencedBy(stored);
    }
  }
};

/**
 * POST /api/marketplace/publish
 */
router.post('/publish', auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id;
    const username = resolveUsername(req);
    if (!userId || !username) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      installableId, name, description, version, kind, scope,
      requires, components, readme, categories, tags,
    } = req.body;

    if (!installableId || !name || !version || !kind) {
      return res.status(400).json({ error: 'installableId, name, version, and kind are required' });
    }

    if (installableId.length > 64) {
      return res.status(400).json({ error: 'installableId must be 64 characters or fewer' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'name must be 100 characters or fewer' });
    }
    if (description && description.length > 500) {
      return res.status(400).json({ error: 'description must be 500 characters or fewer' });
    }
    if (readme && readme.length > 50000) {
      return res.status(400).json({ error: 'readme must be 50,000 characters or fewer' });
    }
    if (!['agent', 'app', 'skill', 'bundle'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be one of: agent, app, skill, bundle' });
    }
    const componentsValidation = normalizeComponents(components);
    if (componentsValidation.error) {
      return res.status(400).json({ error: componentsValidation.error });
    }
    const normalizedComponents = componentsValidation.components;

    const nsError = validateNamespace(installableId.toLowerCase(), username);
    if (nsError) {
      return res.status(400).json({ error: nsError });
    }

    if (scope === 'instance') {
      return res.status(400).json({ error: 'scope "instance" is reserved for admin/builtin manifests' });
    }

    // The claim covers the admission check, so a request that acquires after
    // the winner finished sees the winner's row.
    return await withInstallableClaim(res, installableId.toLowerCase(), async (confirm, fence, superseded) => {
      // A backfilled row is invisible here and is taken over on the create path.
      const existing = await listings.findOne({ installableId: installableId.toLowerCase() });

      if (existing) {
        if (existing.publisher?.userId?.toString() !== userId.toString()) {
          return res.status(403).json({ error: 'Not authorized to update this manifest' });
        }

        const existingVersion = (existing.versions || []).find(
          (v: any) => v.version === version,
        );
        if (existingVersion) {
          return res.status(200).json({
            success: true,
            manifest: {
              installableId: existing.installableId,
              version,
              status: existing.status,
              isNew: false,
            },
          });
        }

        existing.versions = [
          ...(existing.versions || []),
          { version, publishedAt: new Date() },
        ];
        existing.version = version;
        existing.name = name;
        existing.description = description || existing.description;
        if (components) existing.components = normalizedComponents;
        if (requires) existing.requires = requires;
        if (readme !== undefined) existing.readme = readme;
        if (categories || tags) {
          existing.marketplace = {
            ...existing.marketplace?.toObject?.() || existing.marketplace || {},
            published: true,
            category: categories?.[0] || existing.marketplace?.category || '',
            tags: tags || existing.marketplace?.tags || [],
          };
        }

        // Write AR first (load-bearing table), then Installable — same
        // ordering rationale as new-manifest path (§6c.1).
        if (!(await confirm())) return claimExpired(res);
        try {
          await syncToAgentRegistry(existing, 'publish', fence);
        } catch (arError) {
          if (arError instanceof InstallableClaimFenced) throw arError;
          console.warn('[marketplace] AgentRegistry sync failed on update:', (arError as any).message);
          return res.status(201).json({
            success: true,
            warnings: ['AgentRegistry sync failed; retrying publish will fix.'],
            manifest: {
              installableId: existing.installableId,
              version,
              status: existing.status,
              isNew: false,
            },
          });
        }

        if (!(await confirm())) return claimExpired(res);
        try {
          await updateListingFenced(existing, fence);
        } catch (saveError) {
          if (saveError instanceof InstallableClaimFenced) throw saveError;
          // AR succeeded but Installable save failed. Mirror the new-manifest
          // drift-warning path so the caller knows to retry rather than
          // assuming publish fully succeeded.
          console.warn(
            '[marketplace] Installable save failed on update (AR succeeded):',
            (saveError as any).message,
          );
          // A superseded holder lost; only a holder still in the race retries.
          if (await superseded()) return claimExpired(res);
          return res.status(201).json({
            success: true,
            warnings: [
              'Installable catalog write failed; manifest is installable but not yet browsable. Retry publish to sync.',
            ],
            manifest: {
              installableId: existing.installableId,
              version,
              status: existing.status,
              isNew: false,
            },
          });
        }

        if (await superseded()) return claimExpired(res);
        return res.json({
          success: true,
          manifest: {
            installableId: existing.installableId,
            version,
            status: existing.status,
            isNew: false,
          },
        });
      }

      // New manifest: write to AgentRegistry first (load-bearing table), then Installable
      const installableDoc = {
        installableId: installableId.toLowerCase(),
        name,
        description: description || '',
        version,
        kind,
        source: 'marketplace' as const,
        scope: scope || 'pod',
        requires: requires || [],
        components: normalizedComponents || [],
        readme,
        marketplace: {
          published: true,
          category: categories?.[0] || '',
          tags: tags || [],
          verified: false,
          rating: 0,
          ratingCount: 0,
          installCount: 0,
        },
        publisher: { userId, name: username },
        status: 'active' as const,
        versions: [{ version, publishedAt: new Date() }],
        stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 },
      };

      // Write AR first
      if (!(await confirm())) return claimExpired(res);
      try {
        await syncToAgentRegistry(installableDoc, 'publish', fence);
      } catch (arError) {
        if (arError instanceof InstallableClaimFenced) throw arError;
        console.error('[marketplace] AgentRegistry write failed:', (arError as any).message);
        return res.status(500).json({ error: 'Failed to publish manifest' });
      }

      // Then Installable
      if (!(await confirm())) return claimExpired(res);
      let created;
      // The insert is fenced by the unique index: a newer holder's row makes
      // it fail, and the takeover after it refuses to replace that row.
      const fencedDoc = { ...installableDoc, claimFence: fence };
      try {
        created = await takeOverRow(installableDoc.installableId, fencedDoc, userId, fence);
        if (!created) created = await listings.create(fencedDoc);
      } catch (installableError) {
        if (installableError instanceof InstallableClaimFenced) throw installableError;
        console.warn('[marketplace] Installable write failed (AR succeeded):', (installableError as any).message);
        // The hourly backfill, or an older holder, can insert between the read above and create.
        if ((installableError as any)?.code === 11000) {
          if (!(await confirm())) return claimExpired(res);
          try {
            created = await takeOverRow(installableDoc.installableId, fencedDoc, userId, fence);
          } catch (takeoverError) {
            if (takeoverError instanceof InstallableClaimFenced) throw takeoverError;
            console.warn('[marketplace] backfill takeover failed:', (takeoverError as any).message);
          }
        }
      }
      if (!created) {
        // A superseded holder lost; only a holder still in the race retries.
        if (await superseded()) return claimExpired(res);
        return res.status(201).json({
          success: true,
          warnings: [
            'Installable catalog write failed; manifest is installable but not yet browsable. Retry publish to sync.',
          ],
          manifest: {
            installableId: installableDoc.installableId,
            version,
            status: 'active',
            isNew: true,
          },
        });
      }

      if (await superseded()) return claimExpired(res);
      console.log(`[marketplace] action=publish user=${userId} manifest=${created.installableId} version=${version}`);

      return res.status(201).json({
        success: true,
        manifest: {
          installableId: created.installableId,
          version: created.version,
          status: created.status,
          isNew: true,
        },
      });
    });
  } catch (error) {
    console.error('[marketplace] publish error:', error);
    res.status(500).json({ error: (error as any).message || 'Failed to publish' });
  }
});

/**
 * DELETE /api/marketplace/publish/:installableId
 * Soft-delete (unpublish)
 */
router.delete('/publish/:installableId(*)', auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id;
    const { installableId } = req.params;

    const doc = await listings.findOne({ installableId: installableId.toLowerCase() });
    if (!doc) return res.status(404).json({ error: 'Manifest not found' });
    if (doc.publisher?.userId?.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    doc.status = 'unpublished';
    if (doc.marketplace) doc.marketplace.published = false;
    await doc.save();

    try { await syncToAgentRegistry(doc, 'unpublish'); } catch (e) {
      console.warn('[marketplace] AR sync failed on unpublish:', (e as any).message);
    }

    console.log(`[marketplace] action=unpublish user=${userId} manifest=${installableId}`);
    res.json({ success: true, status: 'unpublished' });
  } catch (error) {
    console.error('[marketplace] unpublish error:', error);
    res.status(500).json({ error: 'Failed to unpublish' });
  }
});

/**
 * DELETE /api/marketplace/manifests/:installableId
 * Hard delete (only if 0 active installs)
 */
router.delete('/manifests/:installableId(*)', auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id;
    const { installableId } = req.params;

    const doc = await listings.findOne({ installableId: installableId.toLowerCase() });
    if (!doc) return res.status(404).json({ error: 'Manifest not found' });
    if (doc.publisher?.userId?.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const liveCount = await AgentInstallation.countDocuments({
      agentName: installableId.toLowerCase(),
      status: 'active',
    });
    if (liveCount > 0) {
      return res.status(409).json({
        error: 'Cannot delete a manifest with active installations. Unpublish instead.',
      });
    }

    // ADR-001 invariant #5: Agent User rows, memory, and pod memberships
    // are intentionally NOT cascade-deleted here — identity outlives the
    // manifest. Uninstall-time teardown runs via the AgentInstallation
    // lifecycle elsewhere. Do not add a User / memory cascade to this path.
    try { await AgentRegistry.deleteOne({ agentName: installableId.toLowerCase() }); } catch (e) {
      console.warn('[marketplace] AR delete failed:', (e as any).message);
    }
    await listings.deleteOne({ installableId: installableId.toLowerCase() });

    console.log(`[marketplace] action=delete user=${userId} manifest=${installableId}`);
    res.json({ success: true, deleted: true });
  } catch (error) {
    console.error('[marketplace] delete error:', error);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

/**
 * POST /api/marketplace/fork
 */
router.post('/fork', auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id;
    const username = resolveUsername(req);
    if (!userId || !username) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sourceInstallableId, newInstallableId, newName } = req.body;
    if (!sourceInstallableId || !newInstallableId) {
      return res.status(400).json({ error: 'sourceInstallableId and newInstallableId are required' });
    }

    const nsError = validateNamespace(newInstallableId.toLowerCase(), username);
    if (nsError) return res.status(400).json({ error: nsError });

    // Only a published listing or a builtin is forkable.
    const source = await listings.findOne({
      installableId: sourceInstallableId.toLowerCase(),
      status: 'active',
      $or: [
        { source: 'marketplace', 'marketplace.published': true },
        { source: 'builtin' },
      ],
    });
    if (!source) return res.status(404).json({ error: 'Source manifest not found or not active' });

    // Fork copies `source.components` wholesale into a new `source:
    // 'marketplace'`, `published: true` row, so it is a second writer into the
    // published catalog and needs the same gate as /publish.
    //
    // It is NOT redundant with validating at publish: `builtin` rows are
    // forkable and were never written through /publish, and any row
    // predating this validation is forkable too. Without
    // this check, fork is the path that launders an unvalidated component into
    // the published catalog. (@sprint-review, 58602.)
    const sourceComponentsValidation = normalizeComponents(source.components);
    if (sourceComponentsValidation.error) {
      return res.status(400).json({
        error: `Source manifest cannot be forked: ${sourceComponentsValidation.error}`,
      });
    }

    // The id check runs under the claim, like publish's admission check.
    const forkId = newInstallableId.toLowerCase();
    return await withInstallableClaim(res, forkId, async (confirm, fence, superseded) => {
      // A backfilled row in the caller's own namespace (checked above) is not a
      // claim on the id: an interrupted fork's retry finds the row the sweep
      // inserted from its AgentRegistry write, and takes it over like publish.
      if (await installableIdTaken(forkId) && !(await findBackfillForTakeover(forkId))) {
        return res.status(409).json({ error: 'installableId already taken' });
      }

      const latestVersion = source.version || '1.0.0';

      const forkDoc = {
        installableId: newInstallableId.toLowerCase(),
        name: newName || source.name,
        description: source.description || '',
        version: '1.0.0',
        kind: source.kind,
        source: 'marketplace' as const,
        scope: source.scope,
        requires: source.requires || [],
        components: sourceComponentsValidation.components || [],
        readme: source.readme,
        marketplace: {
          published: true,
          category: source.marketplace?.category || '',
          tags: source.marketplace?.tags || [],
          verified: false,
          rating: 0,
          ratingCount: 0,
          installCount: 0,
        },
        publisher: { userId, name: username },
        status: 'active' as const,
        versions: [{ version: '1.0.0', publishedAt: new Date() }],
        forkedFrom: {
          installableId: source.installableId,
          version: latestVersion,
          forkedAt: new Date(),
        },
        stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 },
      };

      // Write AR first, then Installable
      if (!(await confirm())) return claimExpired(res);
      try {
        await syncToAgentRegistry(forkDoc, 'publish', fence);
      } catch (arError) {
        if (arError instanceof InstallableClaimFenced) throw arError;
        console.error('[marketplace] AR write failed on fork:', (arError as any).message);
        return res.status(500).json({ error: 'Failed to fork manifest' });
      }

      if (!(await confirm())) return claimExpired(res);
      let created;
      const fencedDoc = { ...forkDoc, claimFence: fence };
      try {
        created = await takeOverRow(forkDoc.installableId, fencedDoc, userId, fence);
        if (!created) created = await listings.create(fencedDoc);
      } catch (installableError) {
        if (installableError instanceof InstallableClaimFenced) throw installableError;
        console.warn(
          '[marketplace] Installable create failed on fork (AR succeeded):',
          (installableError as any).message,
        );
        // The hourly backfill can insert between the check above and create.
        if ((installableError as any)?.code === 11000) {
          if (!(await confirm())) return claimExpired(res);
          try {
            created = await takeOverRow(forkDoc.installableId, fencedDoc, userId, fence);
          } catch (takeoverError) {
            if (takeoverError instanceof InstallableClaimFenced) throw takeoverError;
            console.warn('[marketplace] backfill takeover failed on fork:', (takeoverError as any).message);
          }
        }
      }
      if (!created) {
        // AR succeeded but the Installable row didn't land. Mirror the publish
        // path: return 201 with a drift warning so the caller knows to retry.
        // Skip the source forkCount increment — we'll bump it on the retry
        // that actually creates the Installable row.
        // A superseded holder lost; only a holder still in the race retries.
        if (await superseded()) return claimExpired(res);
        return res.status(201).json({
          success: true,
          warnings: [
            'Installable catalog write failed; fork is registered but not yet browsable. Retry fork to sync.',
          ],
          manifest: {
            installableId: forkDoc.installableId,
            version: '1.0.0',
            forkedFrom: forkDoc.forkedFrom,
          },
        });
      }

      // A newer holder took the id over after both writes: the fork lost
      // and is not counted.
      if (await superseded()) return claimExpired(res);

      // Increment fork count on source (atomic)
      await listings.updateOne(
        { installableId: source.installableId },
        { $inc: { 'stats.forkCount': 1 } },
      );

      console.log(`[marketplace] action=fork user=${userId} source=${sourceInstallableId} target=${newInstallableId}`);

      return res.status(201).json({
        success: true,
        manifest: {
          installableId: created.installableId,
          version: '1.0.0',
          forkedFrom: created.forkedFrom,
        },
      });
    });
  } catch (error) {
    console.error('[marketplace] fork error:', error);
    res.status(500).json({ error: (error as any).message || 'Failed to fork' });
  }
});

/**
 * POST /api/marketplace/publish/:installableId/deprecate
 */
router.post('/publish/:installableId(*)/deprecate', auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id;
    const { installableId } = req.params;
    const { version, reason } = req.body;

    if (!version) return res.status(400).json({ error: 'version is required' });

    const doc = await listings.findOne({ installableId: installableId.toLowerCase() });
    if (!doc) return res.status(404).json({ error: 'Manifest not found' });
    if (doc.publisher?.userId?.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const versionEntry = (doc.versions || []).find((v: any) => v.version === version);
    if (!versionEntry) return res.status(404).json({ error: 'Version not found' });

    versionEntry.deprecated = true;
    versionEntry.deprecationReason = reason || '';
    await doc.save();

    try {
      await syncToAgentRegistry(doc, 'deprecate');
    } catch (e) {
      console.warn('[marketplace] AR sync failed on deprecate:', (e as any).message);
    }

    console.log(`[marketplace] action=deprecate user=${userId} manifest=${installableId} version=${version}`);
    res.json({ success: true, version, deprecated: true });
  } catch (error) {
    console.error('[marketplace] deprecate error:', error);
    res.status(500).json({ error: 'Failed to deprecate version' });
  }
});

// Anonymous marketplace reads do a database query per hit, so they get the
// IP tier (middleware/platformRateLimit.ts). A threat-model budget, not one
// fitted to traffic: the ingress log shows almost none on these routes.
const marketplaceReadLimit = platformIpRateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  label: '300 marketplace reads per minute per IP',
});

/**
 * GET /api/marketplace/browse
 */
router.get('/browse', marketplaceReadLimit, async (req: any, res: any) => {
  try {
    const {
      kind, category, q, sort = 'installs', page = '1', limit = '20',
    } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const filter: any = {
      source: 'marketplace',
      status: 'active',
      'marketplace.published': true,
    };
    if (kind) filter.kind = kind;
    if (category) filter['marketplace.category'] = category;
    if (q) filter.$text = { $search: q };

    const sortMap: Record<string, any> = {
      installs: { 'stats.totalInstalls': -1 },
      rating: { 'marketplace.rating': -1 },
      newest: { createdAt: -1 },
      forks: { 'stats.forkCount': -1 },
    };
    const sortObj = sortMap[sort] || sortMap.installs;

    const [items, total] = await Promise.all([
      listings.find(filter)
        .select('-readme -components -versions -claimFence')
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      listings.countDocuments(filter),
    ]);

    res.json({ items, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error('[marketplace] browse error:', error);
    res.status(500).json({ error: 'Failed to browse marketplace' });
  }
});

/**
 * GET /api/marketplace/manifests/:installableId/forks
 * Must be registered before the detail route so the wildcard doesn't eat "/forks".
 */
router.get('/manifests/:installableId(*)/forks', marketplaceReadLimit, async (req: any, res: any) => {
  try {
    const { installableId } = req.params;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = {
      'forkedFrom.installableId': installableId.toLowerCase(),
      status: 'active',
    };

    const [items, total] = await Promise.all([
      listings.find(filter)
        .select('-readme -components -versions -claimFence')
        .sort({ 'stats.totalInstalls': -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      listings.countDocuments(filter),
    ]);

    res.json({ items, total, page, limit });
  } catch (error) {
    console.error('[marketplace] forks error:', error);
    res.status(500).json({ error: 'Failed to list forks' });
  }
});

/**
 * GET /api/marketplace/manifests/:installableId
 */
router.get('/manifests/:installableId(*)', marketplaceReadLimit, async (req: any, res: any) => {
  try {
    const { installableId } = req.params;
    const doc = await listings.findOne({ installableId: installableId.toLowerCase() }).select('-claimFence').lean();
    if (!doc) return res.status(404).json({ error: 'Manifest not found' });
    res.json(doc);
  } catch (error) {
    console.error('[marketplace] detail error:', error);
    res.status(500).json({ error: 'Failed to get manifest' });
  }
});

/**
 * GET /api/marketplace/mine
 */
router.get('/mine', auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const items = await listings.find({ 'publisher.userId': userId })
      .select('-claimFence')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ items, total: items.length });
  } catch (error) {
    console.error('[marketplace] mine error:', error);
    res.status(500).json({ error: 'Failed to list your manifests' });
  }
});

module.exports = router;

export {};
