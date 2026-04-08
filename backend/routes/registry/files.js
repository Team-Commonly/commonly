// Agent file routes — extracted from registry.js (GH#112)
// Handles: persona/generate, heartbeat-file (R/W), identity-file (R/W)
const express = require('express');
const auth = require('../../middleware/auth');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentProfile = require('../../models/AgentProfile');
const AgentIdentityService = require('../../services/agentIdentityService');
const { generateText } = require('../../services/llmService');
const {
  writeOpenClawHeartbeatFile,
  readOpenClawHeartbeatFile,
  readOpenClawIdentityFile,
  writeWorkspaceIdentityFile,
  ensureWorkspaceIdentityFile,
} = require('../../services/agentProvisionerService');
const {
  getUserId,
  normalizeInstanceId,
  resolveInstallation,
  buildAgentProfileId,
  buildIdentityContent,
  userHasPodAccess,
  parseJsonFromText,
} = require('./helpers');

const filesRouter = express.Router({ mergeParams: true });

filesRouter.post('/pods/:podId/agents/:name/persona/generate', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId } = req.body;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const resolved = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });

    if (!resolved.installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const profile = await AgentProfile.findOne({
      agentId: buildAgentProfileId(name, resolved.instanceId),
      podId,
    }).lean();

    const displayName = resolved.installation.displayName || profile?.name || name;
    const purpose = profile?.purpose || resolved.installation?.displayName || name;
    const seed = Math.floor(Math.random() * 1000000);

    const prompt = [
      'You are generating a random but useful persona for an AI agent in a team workspace.',
      `Seed: ${seed}.`,
      `Agent name: ${displayName}.`,
      `Agent purpose/summary: ${purpose}.`,
      'Return ONLY JSON with this shape:',
      '{',
      '  "tone": "string",',
      '  "specialties": ["string", "..."],',
      '  "boundaries": ["string", "..."],',
      '  "customInstructions": "1-2 sentences.",',
      '  "exampleInstructions": "3-6 short bullet lines as plain text, no markdown."',
      '}',
      'Keep specialties and boundaries concrete and short. Avoid emojis.',
    ].join('\n');

    let generated = null;
    try {
      const text = await generateText(prompt, { temperature: 0.7 });
      generated = parseJsonFromText(text);
    } catch (error) {
      console.warn('Persona generation failed, using fallback:', error.message);
    }

    if (!generated || typeof generated !== 'object') {
      generated = {
        tone: 'friendly',
        specialties: ['insight synthesis', 'clear explanations', 'actionable next steps'],
        boundaries: ['avoid speculation', 'ask clarifying questions when unsure', 'be concise'],
        customInstructions: 'Keep answers practical and structured.',
        exampleInstructions: [
          '- Summarize the key points first.',
          '- Ask one clarifying question if needed.',
          '- Offer a concrete next step.',
        ].join('\n'),
      };
    }

    return res.json({
      success: true,
      seed,
      persona: {
        tone: generated.tone || 'friendly',
        specialties: Array.isArray(generated.specialties) ? generated.specialties : [],
        boundaries: Array.isArray(generated.boundaries) ? generated.boundaries : [],
        customInstructions: generated.customInstructions || '',
      },
      exampleInstructions: generated.exampleInstructions || '',
    });
  } catch (error) {
    console.error('Error generating agent persona:', error);
    return res.status(500).json({ error: 'Failed to generate persona' });
  }
});

/**
 * GET /pods/:podId/agents/:name/heartbeat-file
 * Read the agent's current HEARTBEAT.md from workspace (or AgentProfile cache)
 */
filesRouter.get('/pods/:podId/agents/:name/heartbeat-file', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId } = req.query;
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const pod = await Pod.findById(podId).lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });
    if (!membership && !isCreator) return res.status(403).json({ error: 'Access denied' });

    const resolved = await resolveInstallation({ agentName: name, podId, instanceId });
    if (!resolved.installation) return res.status(404).json({ error: 'Agent not installed in this pod' });

    const accountId = normalizeInstanceId(resolved.instanceId);

    // Try reading live from PVC first; fall back to AgentProfile cached copy
    let content = '';
    let readFromWorkspace = false;
    try {
      content = await readOpenClawHeartbeatFile(accountId);
      readFromWorkspace = Boolean(String(content || '').trim());
    } catch (_) { /* fall through */ }

    if (!content) {
      const profile = await AgentProfile.findOne({
        podId,
        agentName: name.toLowerCase(),
        instanceId: resolved.instanceId,
      }).select('heartbeatContent').lean();
      content = profile?.heartbeatContent || '';
    } else if (readFromWorkspace) {
      AgentProfile.updateMany(
        { podId, agentName: name.toLowerCase(), instanceId: resolved.instanceId },
        { $set: { heartbeatContent: content } },
      ).catch((profileErr) => {
        console.warn('[heartbeat-file] Failed to sync AgentProfile cache from workspace:', profileErr.message);
      });
    }

    return res.json({ content, accountId });
  } catch (error) {
    console.error('Error reading heartbeat file:', error);
    return res.status(500).json({ error: 'Failed to read heartbeat file' });
  }
});

filesRouter.post('/pods/:podId/agents/:name/heartbeat-file', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, content, reset } = req.body;
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (name.toLowerCase() !== 'openclaw') {
      return res.status(400).json({ error: 'Heartbeat file updates are only supported for OpenClaw agents.' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });

    if (!membership && !isCreator) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const resolved = await resolveInstallation({
      agentName: name,
      podId,
      instanceId,
    });

    if (!resolved.installation) {
      return res.status(404).json({ error: 'Agent not installed in this pod' });
    }

    const normalizedInstanceId = normalizeInstanceId(resolved.instanceId);
    const accountId = normalizedInstanceId;
    const trimmed = String(content || '').trim();
    const normalized = trimmed
      ? (trimmed.startsWith('#') ? `${trimmed}\n` : `# HEARTBEAT.md\n\n${trimmed}\n`)
      : '# HEARTBEAT.md\n\n';

    const filePath = await writeOpenClawHeartbeatFile(accountId, normalized, { allowEmpty: true });

    // Persist to AgentProfile so config card can read it without PVC access
    try {
      await AgentProfile.updateMany(
        { podId, agentName: name.toLowerCase(), instanceId: resolved.instanceId },
        { $set: { heartbeatContent: normalized } },
      );
    } catch (profileErr) {
      console.warn('[heartbeat-file] Failed to persist to AgentProfile:', profileErr.message);
    }

    return res.json({ success: true, path: filePath, reset: Boolean(reset) });
  } catch (error) {
    console.error('Error updating heartbeat file:', error);
    return res.status(500).json({ error: 'Failed to update heartbeat file' });
  }
});

/**
 * GET /api/registry/pods/:podId/agents/:name/identity-file
 * Read IDENTITY.md from agent workspace
 */
filesRouter.get('/pods/:podId/agents/:name/identity-file', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId } = req.query;
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const pod = await Pod.findById(podId).lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });
    if (!membership && !isCreator) return res.status(403).json({ error: 'Access denied' });

    const resolved = await resolveInstallation({ agentName: name, podId, instanceId });
    if (!resolved.installation) return res.status(404).json({ error: 'Agent not installed in this pod' });

    const accountId = normalizeInstanceId(resolved.instanceId);

    let content = '';
    try {
      content = await readOpenClawIdentityFile(accountId);
    } catch (_) { /* fall through */ }

    return res.json({ content, accountId });
  } catch (error) {
    console.error('Error reading identity file:', error);
    return res.status(500).json({ error: 'Failed to read identity file' });
  }
});

/**
 * POST /api/registry/pods/:podId/agents/:name/identity-file
 * Write IDENTITY.md to agent workspace
 */
filesRouter.post('/pods/:podId/agents/:name/identity-file', auth, async (req, res) => {
  try {
    const { podId, name } = req.params;
    const { instanceId, content } = req.body;
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    if (name.toLowerCase() !== 'openclaw') {
      return res.status(400).json({ error: 'Identity file updates are only supported for OpenClaw agents.' });
    }

    const pod = await Pod.findById(podId).lean();
    if (!pod) return res.status(404).json({ error: 'Pod not found' });

    const isCreator = pod.createdBy?.toString() === userId.toString();
    const membership = pod.members?.find((m) => {
      if (!m) return false;
      const memberId = m.userId?.toString?.() || m.toString?.();
      return memberId && memberId === userId.toString();
    });
    if (!membership && !isCreator) return res.status(403).json({ error: 'Access denied' });

    const resolved = await resolveInstallation({ agentName: name, podId, instanceId });
    if (!resolved.installation) return res.status(404).json({ error: 'Agent not installed in this pod' });

    const accountId = normalizeInstanceId(resolved.instanceId);
    const normalized = String(content || '').trim();
    const filePath = await writeWorkspaceIdentityFile(accountId, normalized);

    return res.json({ success: true, path: filePath });
  } catch (error) {
    console.error('Error updating identity file:', error);
    return res.status(500).json({ error: 'Failed to update identity file' });
  }
});

module.exports = filesRouter;
