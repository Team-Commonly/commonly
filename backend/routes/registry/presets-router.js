// Agent preset routes — extracted from registry.js (GH#112)
// Handles: GET /presets
const express = require('express');
const auth = require('../../middleware/auth');
const { hasAnyEnv } = require('./helpers');
const {
  detectGatewayPresetCapabilities,
  detectBuiltInOpenClawSkills,
  detectDockerfileCommonlyPackages,
  binLooksInstalled,
} = require('./detect');
const { PRESET_DEFINITIONS } = require('./presets');

const presetsRouter = express.Router();

const resolvePresetTool = (tool, capabilities) => {
  if (tool.type === 'core') {
    return { ...tool, available: true };
  }
  if (tool.type === 'plugin') {
    const pluginSpecs = (capabilities.plugins || [])
      .map((plugin) => `${plugin.name || ''} ${plugin.spec || ''}`.toLowerCase());
    const available = (tool.matchAny || []).some((needle) => pluginSpecs.some((spec) => spec.includes(needle)));
    return { ...tool, available };
  }
  return { ...tool, available: false };
};

const resolvePresetApiRequirement = (requirement) => ({
  ...requirement,
  configured: hasAnyEnv(requirement.envAny || [requirement.key]),
});

const resolvePresetSkills = ({ preset, builtInSkills, dockerCapabilities }) => {
  const skillMap = new Map((builtInSkills.skills || []).map((skill) => [skill.id, skill]));
  const defaultSkills = Array.isArray(preset.defaultSkills) ? preset.defaultSkills : [];
  return defaultSkills.map((entry) => {
    const builtIn = skillMap.get(entry.id);
    const requiresBins = Array.isArray(builtIn?.requiresBins) ? builtIn.requiresBins : [];
    const requiresEnv = Array.isArray(builtIn?.requiresEnv) ? builtIn.requiresEnv : [];
    const binsReady = requiresBins.every((bin) => binLooksInstalled(bin, dockerCapabilities));
    const envReady = requiresEnv.every((envName) => hasAnyEnv([envName]));
    const binStatus = requiresBins.map((bin) => ({
      bin,
      installed: binLooksInstalled(bin, dockerCapabilities),
    }));
    const envStatus = requiresEnv.map((envKey) => ({
      key: envKey,
      configured: hasAnyEnv([envKey]),
    }));
    let setupStatus = 'ready';
    if (!builtIn) setupStatus = 'missing-skill';
    else if (!binsReady) setupStatus = 'needs-package-install';
    else if (!envReady) setupStatus = 'needs-api-env';
    return {
      id: entry.id,
      reason: entry.reason || '',
      available: Boolean(builtIn),
      requirements: {
        bins: requiresBins,
        env: requiresEnv,
      },
      binStatus,
      envStatus,
      setupStatus,
      readiness: {
        binsReady,
        envReady,
        ready: Boolean(builtIn) && binsReady && envReady,
      },
    };
  });
};

/**
 * GET /api/registry/presets
 * List agent presets with capability readiness
 */
presetsRouter.get('/presets', auth, async (req, res) => {
  try {
    const capabilities = await detectGatewayPresetCapabilities();
    const builtInSkills = detectBuiltInOpenClawSkills();
    const dockerCapabilities = detectDockerfileCommonlyPackages();
    const presets = PRESET_DEFINITIONS.map((preset) => {
      const resolvedSkills = resolvePresetSkills({
        preset,
        builtInSkills,
        dockerCapabilities,
      });
      const recommendedEnvMap = new Map();
      (preset.apiRequirements || []).forEach((requirement) => {
        const key = String(requirement.key || '').trim();
        if (!key) return;
        recommendedEnvMap.set(key, {
          key,
          purpose: requirement.purpose || '',
          configured: hasAnyEnv(requirement.envAny || [key]),
          source: 'preset-api',
        });
      });
      resolvedSkills.forEach((skill) => {
        (skill.envStatus || []).forEach((envEntry) => {
          if (!envEntry?.key) return;
          if (!recommendedEnvMap.has(envEntry.key)) {
            recommendedEnvMap.set(envEntry.key, {
              key: envEntry.key,
              purpose: `Required by skill ${skill.id}`,
              configured: Boolean(envEntry.configured),
              source: 'skill',
            });
          }
        });
      });
      return {
        ...preset,
        requiredTools: (preset.requiredTools || []).map(
          (tool) => resolvePresetTool(tool, capabilities),
        ),
        apiRequirements: (preset.apiRequirements || []).map(resolvePresetApiRequirement),
        defaultSkills: resolvedSkills,
        recommendedEnv: Array.from(recommendedEnvMap.values()),
        readiness: (() => {
          const toolsReady = (preset.requiredTools || [])
            .every((tool) => resolvePresetTool(tool, capabilities).available);
          const apisReady = (preset.apiRequirements || [])
            .every((requirement) => hasAnyEnv(requirement.envAny || [requirement.key]));
          const skillsReady = resolvedSkills.every((skill) => skill.readiness.ready);
          return {
            toolsReady,
            apisReady,
            skillsReady,
            ready: toolsReady && apisReady && skillsReady,
          };
        })(),
      };
    });

    return res.json({
      presets,
      capabilities,
      runtimeSkills: builtInSkills,
      dockerCapabilities,
    });
  } catch (error) {
    console.error('Error listing agent presets:', error);
    return res.status(500).json({ error: 'Failed to list agent presets' });
  }
});

module.exports = presetsRouter;
