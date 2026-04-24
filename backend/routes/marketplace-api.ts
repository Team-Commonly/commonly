const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const Installable = require('../models/Installable');
const { AgentRegistry, AgentInstallation } = require('../models/AgentRegistry');

const router = express.Router();

const NAMESPACE_RE = /^@[a-z0-9-]+\/[a-z0-9-]+$/;

const resolveUsername = async (req: any): Promise<string | null> => {
  if (req.user?.username) return req.user.username;
  const userId = req.userId || req.user?.id;
  if (!userId) return null;
  const user = await User.findById(userId).select('username').lean();
  return user?.username || null;
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

const syncToAgentRegistry = async (installable: any, action: 'publish' | 'unpublish' | 'delete' | 'deprecate') => {
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

  await AgentRegistry.findOneAndUpdate(
    { agentName },
    { $set: arPayload },
    { upsert: true, new: true },
  );
};

/**
 * POST /api/marketplace/publish
 */
router.post('/publish', auth, async (req: any, res: any) => {
  try {
    const userId = req.userId || req.user?.id;
    const username = await resolveUsername(req);
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
    if (components && components.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 components per manifest' });
    }

    const nsError = validateNamespace(installableId.toLowerCase(), username);
    if (nsError) {
      return res.status(400).json({ error: nsError });
    }

    if (scope === 'instance') {
      return res.status(400).json({ error: 'scope "instance" is reserved for admin/builtin manifests' });
    }

    const existing = await Installable.findOne({ installableId: installableId.toLowerCase() });

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
      if (components) existing.components = components;
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
      try {
        await syncToAgentRegistry(existing, 'publish');
      } catch (arError) {
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

      try {
        await existing.save();
      } catch (saveError) {
        // AR succeeded but Installable save failed. Mirror the new-manifest
        // drift-warning path so the caller knows to retry rather than
        // assuming publish fully succeeded.
        console.warn(
          '[marketplace] Installable save failed on update (AR succeeded):',
          (saveError as any).message,
        );
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
      components: components || [],
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
    try {
      await syncToAgentRegistry(installableDoc, 'publish');
    } catch (arError) {
      console.error('[marketplace] AgentRegistry write failed:', (arError as any).message);
      return res.status(500).json({ error: 'Failed to publish manifest' });
    }

    // Then Installable
    let created;
    try {
      created = await Installable.create(installableDoc);
    } catch (installableError) {
      console.warn('[marketplace] Installable write failed (AR succeeded):', (installableError as any).message);
      return res.status(201).json({
        success: true,
        warnings: ['Installable catalog write failed; manifest is installable but not yet browsable. Retry publish to sync.'],
        manifest: {
          installableId: installableDoc.installableId,
          version,
          status: 'active',
          isNew: true,
        },
      });
    }

    console.log(`[marketplace] action=publish user=${userId} manifest=${created.installableId} version=${version}`);

    res.status(201).json({
      success: true,
      manifest: {
        installableId: created.installableId,
        version: created.version,
        status: created.status,
        isNew: true,
      },
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

    const doc = await Installable.findOne({ installableId: installableId.toLowerCase() });
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

    const doc = await Installable.findOne({ installableId: installableId.toLowerCase() });
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
    await Installable.deleteOne({ installableId: installableId.toLowerCase() });

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
    const username = await resolveUsername(req);
    if (!userId || !username) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { sourceInstallableId, newInstallableId, newName } = req.body;
    if (!sourceInstallableId || !newInstallableId) {
      return res.status(400).json({ error: 'sourceInstallableId and newInstallableId are required' });
    }

    const nsError = validateNamespace(newInstallableId.toLowerCase(), username);
    if (nsError) return res.status(400).json({ error: nsError });

    const source = await Installable.findOne({
      installableId: sourceInstallableId.toLowerCase(),
      status: 'active',
    });
    if (!source) return res.status(404).json({ error: 'Source manifest not found or not active' });

    const existing = await Installable.findOne({ installableId: newInstallableId.toLowerCase() });
    if (existing) return res.status(409).json({ error: 'installableId already taken' });

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
      components: source.components || [],
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
    try {
      await syncToAgentRegistry(forkDoc, 'publish');
    } catch (arError) {
      console.error('[marketplace] AR write failed on fork:', (arError as any).message);
      return res.status(500).json({ error: 'Failed to fork manifest' });
    }

    let created;
    try {
      created = await Installable.create(forkDoc);
    } catch (installableError) {
      // AR succeeded but the Installable row didn't land. Mirror the publish
      // path: return 201 with a drift warning so the caller knows to retry.
      // Skip the source forkCount increment — we'll bump it on the retry
      // that actually creates the Installable row.
      console.warn(
        '[marketplace] Installable create failed on fork (AR succeeded):',
        (installableError as any).message,
      );
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

    // Increment fork count on source (atomic)
    await Installable.updateOne(
      { installableId: source.installableId },
      { $inc: { 'stats.forkCount': 1 } },
    );

    console.log(`[marketplace] action=fork user=${userId} source=${sourceInstallableId} target=${newInstallableId}`);

    res.status(201).json({
      success: true,
      manifest: {
        installableId: created.installableId,
        version: '1.0.0',
        forkedFrom: created.forkedFrom,
      },
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

    const doc = await Installable.findOne({ installableId: installableId.toLowerCase() });
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

/**
 * GET /api/marketplace/browse
 */
router.get('/browse', async (req: any, res: any) => {
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
      Installable.find(filter)
        .select('-readme -components -versions')
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Installable.countDocuments(filter),
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
router.get('/manifests/:installableId(*)/forks', async (req: any, res: any) => {
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
      Installable.find(filter)
        .select('-readme -components -versions')
        .sort({ 'stats.totalInstalls': -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Installable.countDocuments(filter),
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
router.get('/manifests/:installableId(*)', async (req: any, res: any) => {
  try {
    const { installableId } = req.params;
    const doc = await Installable.findOne({ installableId: installableId.toLowerCase() }).lean();
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

    const items = await Installable.find({ 'publisher.userId': userId })
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
