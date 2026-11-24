// Agent preset routes — extracted from registry.js (GH#112)
// Handles: GET /presets
//
// Readiness here is env-only. Plugin, bundled-skill and Dockerfile detection
// read the retired OpenClaw gateway and its source tree, so they left with it
// (ADR-021); no surviving preset declares a plugin tool or a default skill.
const express = require('express');
const auth = require('../../middleware/auth');
const { hasAnyEnv } = require('./helpers');
const { PRESET_DEFINITIONS } = require('./presets');
const { manifests } = require('../../integrations/manifests');

const presetsRouter = express.Router();

const isManifestReady = (id: string): boolean => {
  const readiness = manifests?.[id]?.readiness;
  return typeof readiness === 'function' && readiness().available === true;
};

const detectPresetCapabilities = () => ({
  generatedAt: new Date().toISOString(),
  llmProviders: {
    google: hasAnyEnv(['GEMINI_API_KEY']),
    openai: hasAnyEnv(['OPENAI_API_KEY']),
    anthropic: hasAnyEnv(['ANTHROPIC_API_KEY']),
    litellm: hasAnyEnv(['LITELLM_BASE_URL']),
  },
  integrations: {
    discord: hasAnyEnv(['DISCORD_BOT_TOKEN']),
    slack: isManifestReady('slack'),
    telegram: hasAnyEnv(['TELEGRAM_BOT_TOKEN']),
    x: hasAnyEnv(['X_API_BASE_URL']),
    instagram: hasAnyEnv(['INSTAGRAM_GRAPH_API_BASE']),
  },
});

const resolvePresetTool = (tool: any) => ({ ...tool, available: tool.type === 'core' });

const resolvePresetApiRequirement = (requirement: any) => ({
  ...requirement,
  configured: hasAnyEnv(requirement.envAny || [requirement.key]),
});

/**
 * GET /api/registry/presets
 * List agent presets with capability readiness
 */
presetsRouter.get('/presets', auth, async (req: any, res: any) => {
  try {
    const capabilities = detectPresetCapabilities();
    const presets = PRESET_DEFINITIONS.map((preset: any) => {
      const requiredTools = (preset.requiredTools || []).map(resolvePresetTool);
      const apiRequirements = (preset.apiRequirements || []).map(resolvePresetApiRequirement);
      const recommendedEnvMap = new Map();
      apiRequirements.forEach((requirement: any) => {
        const key = String(requirement.key || '').trim();
        if (!key) return;
        recommendedEnvMap.set(key, {
          key,
          purpose: requirement.purpose || '',
          configured: requirement.configured,
          source: 'preset-api',
        });
      });
      const recommendedEnv = Array.from(recommendedEnvMap.values());
      const toolsReady = requiredTools.every((tool: any) => tool.available);
      const apisReady = apiRequirements.every((requirement: any) => requirement.configured);
      return {
        ...preset,
        requiredTools,
        apiRequirements,
        recommendedEnv,
        readiness: { toolsReady, apisReady, ready: toolsReady && apisReady },
      };
    });

    return res.json({ presets, capabilities });
  } catch (error) {
    console.error('Error listing agent presets:', error);
    return res.status(500).json({ error: 'Failed to list agent presets' });
  }
});

module.exports = presetsRouter;

export {};
