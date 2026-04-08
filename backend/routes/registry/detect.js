// Gateway/environment detection helpers — extracted from registry.js (GH#112)
const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');
const { hasAnyEnv } = require('./helpers');
const { listOpenClawPlugins } = require('../../services/agentProvisionerService');

const detectGatewayPresetCapabilities = async () => {
  const capability = {
    generatedAt: new Date().toISOString(),
    pluginStatus: 'unknown',
    plugins: [],
    llmProviders: {
      google: hasAnyEnv(['GEMINI_API_KEY']),
      openai: hasAnyEnv(['OPENAI_API_KEY']),
      anthropic: hasAnyEnv(['ANTHROPIC_API_KEY']),
      litellm: hasAnyEnv(['LITELLM_BASE_URL']),
    },
    integrations: {
      discord: hasAnyEnv(['DISCORD_BOT_TOKEN']),
      slack: hasAnyEnv(['SLACK_BOT_TOKEN', 'SLACK_CLIENT_ID']),
      telegram: hasAnyEnv(['TELEGRAM_BOT_TOKEN']),
      x: hasAnyEnv(['X_API_BASE_URL']),
      instagram: hasAnyEnv(['INSTAGRAM_GRAPH_API_BASE']),
    },
  };

  try {
    const report = await listOpenClawPlugins();
    const plugins = Array.isArray(report?.plugins) ? report.plugins : [];
    capability.pluginStatus = 'detected';
    capability.plugins = plugins.map((plugin) => ({
      name: plugin.name || '',
      spec: plugin.spec || plugin.name || '',
      version: plugin.version || '',
    }));
  } catch (error) {
    capability.pluginStatus = 'unavailable';
    capability.plugins = [];
  }

  return capability;
};

const DOCKERFILE_PATH_CANDIDATES = [
  path.resolve(__dirname, '../../_external/clawdbot/Dockerfile.commonly'),
  '/repo/_external/clawdbot/Dockerfile.commonly',
];

const SKILLS_DIR_CANDIDATES = [
  path.resolve(__dirname, '../../_external/clawdbot/skills'),
  '/repo/_external/clawdbot/skills',
];

const OPENCLAW_METADATA_REGEX = /^---\s*[\s\S]*?metadata:\s*([\s\S]*?)\n---/m;
const ENV_HINT_REGEX = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g;

const findFirstExistingPath = (candidates = []) => candidates.find((candidate) => {
  try {
    return fs.existsSync(candidate);
  } catch (error) {
    return false;
  }
}) || null;

const parseSkillMetadata = (skillContent) => {
  if (!skillContent) return {};
  const match = skillContent.match(OPENCLAW_METADATA_REGEX);
  if (!match) return {};
  const raw = String(match[1] || '').trim();
  if (!raw) return {};
  try {
    return JSON5.parse(raw);
  } catch (error) {
    return {};
  }
};

const extractEnvHints = (skillContent) => {
  if (!skillContent) return [];
  const hits = new Set();
  let match;
  while ((match = ENV_HINT_REGEX.exec(skillContent)) !== null) {
    hits.add(match[0]);
  }
  return Array.from(hits).sort();
};

const detectBuiltInOpenClawSkills = () => {
  const skillsDir = findFirstExistingPath(SKILLS_DIR_CANDIDATES);
  if (!skillsDir) {
    return { status: 'unavailable', skills: [] };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch (error) {
    return { status: 'unavailable', skills: [] };
  }

  const skills = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((skillName) => {
      const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
      let content = '';
      try {
        content = fs.readFileSync(skillFile, 'utf8');
      } catch (error) {
        content = '';
      }
      const metadata = parseSkillMetadata(content);
      const openclawMeta = metadata?.openclaw || {};
      const requires = openclawMeta.requires || {};
      return {
        id: skillName,
        requiresBins: Array.isArray(requires.bins) ? requires.bins : [],
        requiresEnv: Array.isArray(requires.env) ? requires.env : extractEnvHints(content),
      };
    });

  return {
    status: 'detected',
    skills,
  };
};

const detectDockerfileCommonlyPackages = () => {
  const dockerfilePath = findFirstExistingPath(DOCKERFILE_PATH_CANDIDATES);
  if (!dockerfilePath) {
    return { status: 'unavailable', aptPackages: [], pythonPackages: [] };
  }
  let content = '';
  try {
    content = fs.readFileSync(dockerfilePath, 'utf8');
  } catch (error) {
    return { status: 'unavailable', aptPackages: [], pythonPackages: [] };
  }

  const aptMatch = content.match(/apt-get install -y --no-install-recommends([\s\S]*?)&&/m);
  const aptPackages = aptMatch
    ? aptMatch[1]
      .split('\n')
      .map((line) => line.replace(/[#\\]/g, '').trim())
      .filter(Boolean)
      .flatMap((line) => line.split(/\s+/))
      .filter(Boolean)
    : [];

  const pythonPackages = [];
  const pipInstallMatches = content.match(/pip install --no-cache-dir\s+([^\n]+)/g) || [];
  pipInstallMatches.forEach((line) => {
    const parts = line.split(/\s+/).filter(Boolean);
    const pkg = parts[parts.length - 1];
    if (pkg && pkg !== '--upgrade' && pkg !== 'pip') {
      pythonPackages.push(pkg.trim());
    }
  });

  return {
    status: 'detected',
    aptPackages: Array.from(new Set(aptPackages)).sort(),
    pythonPackages: Array.from(new Set(pythonPackages)).sort(),
  };
};

const binLooksInstalled = (binName, dockerCapabilities) => {
  const name = String(binName || '').trim().toLowerCase();
  if (!name) return false;
  const aptSet = new Set((dockerCapabilities.aptPackages || []).map((pkg) => String(pkg).toLowerCase()));
  const pythonSet = new Set(
    (dockerCapabilities.pythonPackages || []).map((pkg) => String(pkg).toLowerCase()),
  );

  const binToPkg = {
    rg: 'ripgrep',
    yq: 'yq',
    ffmpeg: 'ffmpeg',
    git: 'git',
    gh: 'gh',
    jq: 'jq',
    python3: 'python3',
    uv: 'uv',
    clawhub: 'clawhub',
  };
  const packageName = binToPkg[name] || name;
  return aptSet.has(packageName) || pythonSet.has(packageName);
};

module.exports = {
  detectGatewayPresetCapabilities,
  detectBuiltInOpenClawSkills,
  detectDockerfileCommonlyPackages,
  binLooksInstalled,
};
