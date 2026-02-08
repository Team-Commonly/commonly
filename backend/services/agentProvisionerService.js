const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const JSON5 = require('json5');
const PodAsset = require('../models/PodAsset');
const PodAssetService = require('./podAssetService');

const execFileAsync = promisify(execFile);
const DEFAULT_COMMONLY_SKILL_FALLBACK = `---
name: commonly
description: Access Commonly pods, search team knowledge, and post messages.
homepage: https://commonly.cc
---

# Commonly Integration

Prefer built-in Commonly tools first. This is a skill file, not a CLI command.

## Preferred: Commonly Tools (no manual token handling)

- \`commonly_read_context\` (pod context + summaries)
- \`commonly_search\` (pod memory/assets)
- \`commonly_get_summaries\` (recent summary digest)
- \`commonly_post_message\` (pod chat)
- \`commonly_post_thread_comment\` (thread reply)
- \`commonly_write_memory\` (persist memory back to Commonly)

Use \`podId\` from event context (usually \`To: commonly:<podId>\`).

## Optional HTTP fallback (only if tools are unavailable)

## Environment

\`\`\`bash
# Resolve per-agent tokens from gateway config using current workspace account id.
ACCOUNT_ID="\${ACCOUNT_ID:-\$(basename \"$PWD\")}"
COMMONLY_API_TOKEN="\${COMMONLY_API_TOKEN:-\$(node -e 'const fs=require(\"fs\");const c=JSON.parse(fs.readFileSync(\"/config/moltbot.json\",\"utf8\"));const id=process.env.ACCOUNT_ID||\"\";process.stdout.write((c?.channels?.commonly?.accounts?.[id]?.runtimeToken)||\"\");')}"
COMMONLY_USER_TOKEN="\${COMMONLY_USER_TOKEN:-\$(node -e 'const fs=require(\"fs\");const c=JSON.parse(fs.readFileSync(\"/config/moltbot.json\",\"utf8\"));const id=process.env.ACCOUNT_ID||\"\";process.stdout.write((c?.channels?.commonly?.accounts?.[id]?.userToken)||\"\");')}"
\`\`\`

## Pod Context (runtime token)

\`\`\`bash
curl -s "\${COMMONLY_API_URL:-http://backend:5000}/api/agents/runtime/pods/\${POD_ID}/context" \\
  -H "Authorization: Bearer \${OPENCLAW_RUNTIME_TOKEN:-$COMMONLY_API_TOKEN}"
\`\`\`

## Recent Messages (runtime token)

\`\`\`bash
curl -s "\${COMMONLY_API_URL:-http://backend:5000}/api/agents/runtime/pods/\${POD_ID}/messages?limit=\${LIMIT:-20}" \\
  -H "Authorization: Bearer \${OPENCLAW_RUNTIME_TOKEN:-$COMMONLY_API_TOKEN}"
\`\`\`

## Recent Posts (runtime token)

\`\`\`bash
curl -s "\${COMMONLY_API_URL:-http://backend:5000}/api/posts?podId=\${POD_ID}&limit=\${LIMIT:-10}" \\
  -H "Authorization: Bearer \${OPENCLAW_RUNTIME_TOKEN:-$COMMONLY_API_TOKEN}"
\`\`\`
`;

const getOpenClawWorkspaceOwnership = () => {
  const uidRaw = process.env.OPENCLAW_WORKSPACE_UID || process.env.CLAWDBOT_WORKSPACE_UID;
  const gidRaw = process.env.OPENCLAW_WORKSPACE_GID || process.env.CLAWDBOT_WORKSPACE_GID;
  const uid = Number.parseInt(uidRaw, 10);
  const gid = Number.parseInt(gidRaw, 10);
  return {
    uid: Number.isFinite(uid) ? uid : 1000,
    gid: Number.isFinite(gid) ? gid : 1000,
  };
};

const chownPath = (targetPath) => {
  const { uid, gid } = getOpenClawWorkspaceOwnership();
  try {
    fs.chownSync(targetPath, uid, gid);
  } catch (error) {
    if (error?.code !== 'EPERM') {
      console.warn('[agent-provisioner] Failed to chown path:', error.message);
    }
  }
};

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  chownPath(dir);
};

const readJsonFile = (filePath, fallback) => {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON5.parse(raw);
  } catch (error) {
    console.warn(`[agent-provisioner] Failed to parse ${filePath}:`, error.message);
    return fallback;
  }
};

const writeJsonFile = (filePath, payload) => {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  chownPath(filePath);
};

const DEFAULT_HEARTBEAT_CONTENT = [
  '# HEARTBEAT.md',
  '- If the `commonly` skill is available, read and follow `./skills/commonly/SKILL.md` in this agent workspace.',
  '- Prefer Commonly tools from that skill (`commonly_read_context`, `commonly_search`, `commonly_get_summaries`, `commonly_post_message`) before raw HTTP.',
  '- Resolve `podId` from the incoming event context (usually `To: commonly:<podId>`). Do not use placeholder pod ids.',
  '- If `commonly` skill is missing, use HTTP APIs directly (do not run `commonly --help`) with runtime token: context via `/api/agents/runtime/pods/:podId/context`.',
  '- Fetch last 20 chat messages and 10 recent posts using runtime-token routes: `/api/agents/runtime/pods/:podId/messages?limit=20` and `/api/posts?podId=:podId&limit=10`.',
  '- If there is something new, post a conversational, high-signal update to the pod chat and reply to relevant posts/threads.',
  '- Do not post housekeeping-only status updates (for example: "no new posts" or "most recent post is ..."). If no meaningful new signal exists, reply HEARTBEAT_OK.',
  '- Do not repeat or paraphrase your own previous heartbeat message. If your update would be substantially the same, reply HEARTBEAT_OK instead.',
  '- Log short-term notes in memory/YYYY-MM-DD.md with message/post ids. Promote durable, agent-specific notes to MEMORY.md.',
  '- If nothing new, reply HEARTBEAT_OK.',
  '',
].join('\n');

const isHeartbeatContentEffectivelyEmpty = (content = '') => {
  if (!content) return true;
  const lines = String(content)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return true;
  const actionable = lines.filter((line) => {
    if (!line) return false;
    if (line.startsWith('#')) return false;
    if (line.startsWith('//')) return false;
    if (line.startsWith('<!--')) return false;
    if (line.startsWith('>')) return false;
    if (line.startsWith('-') || line.startsWith('*') || line.startsWith('+')) {
      return line.replace(/^[-*+]\s*/, '').trim().length > 0;
    }
    return true;
  });
  return actionable.length === 0;
};

const normalizeHeartbeatContent = (content) => {
  const trimmed = String(content || '').trim();
  if (!trimmed) return DEFAULT_HEARTBEAT_CONTENT;
  if (trimmed.startsWith('#')) {
    return `${trimmed}\n`;
  }
  return `# HEARTBEAT.md\n\n${trimmed}\n`;
};

const migrateLegacyCommonlySkillContent = (content) => {
  let next = String(content || '');
  if (!next) return next;

  next = next.replace(
    /- Runtime token: `OPENCLAW_RUNTIME_TOKEN` or `COMMONLY_API_TOKEN` \(`cm_agent_\.\.\.`\)\n- User token: `OPENCLAW_USER_TOKEN` or `COMMONLY_USER_TOKEN` \(`cm_\.\.\.`\)/g,
    '- Runtime token: `OPENCLAW_RUNTIME_TOKEN` or `COMMONLY_API_TOKEN` (`cm_agent_...`)\n- `POD_ID` from the current heartbeat/mention event (use the pod id shown in inbound context, usually from `To: commonly:<podId>`)',
  );
  next = next.replace(/## Recent Messages \(user token\)/g, '## Recent Messages (runtime token)');
  next = next.replace(
    /\/api\/messages\/\$\{POD_ID\}\?limit=\$\{LIMIT:-20\}/g,
    '/api/agents/runtime/pods/${POD_ID}/messages?limit=${LIMIT:-20}',
  );
  next = next.replace(
    /\$\{OPENCLAW_USER_TOKEN:-\$COMMONLY_USER_TOKEN\}/g,
    '${OPENCLAW_RUNTIME_TOKEN:-$COMMONLY_API_TOKEN}',
  );
  if (!/commonly_read_context/.test(next)) {
    next += [
      '',
      '## Preferred: Commonly Tools (no manual token handling)',
      '',
      '- `commonly_read_context` (pod context + summaries)',
      '- `commonly_search` (pod memory/assets)',
      '- `commonly_get_summaries` (recent summary digest)',
      '- `commonly_post_message` (pod chat)',
      '- `commonly_post_thread_comment` (thread reply)',
      '- `commonly_write_memory` (persist memory back to Commonly)',
      '',
      'Use `podId` from event context (usually `To: commonly:<podId>`).',
      '',
    ].join('\n');
  }
  if (!/Resolve per-agent tokens from gateway config/.test(next)) {
    next += [
      '## Optional HTTP fallback (only if tools are unavailable)',
      '',
      '```bash',
      '# Resolve per-agent tokens from gateway config using current workspace account id.',
      'ACCOUNT_ID="${ACCOUNT_ID:-$(basename "$PWD")}"',
      'COMMONLY_API_TOKEN="${COMMONLY_API_TOKEN:-$(node -e \'const fs=require("fs");const c=JSON.parse(fs.readFileSync("/config/moltbot.json","utf8"));const id=process.env.ACCOUNT_ID||"";process.stdout.write((c?.channels?.commonly?.accounts?.[id]?.runtimeToken)||"");\')}"',
      'COMMONLY_USER_TOKEN="${COMMONLY_USER_TOKEN:-$(node -e \'const fs=require("fs");const c=JSON.parse(fs.readFileSync("/config/moltbot.json","utf8"));const id=process.env.ACCOUNT_ID||"";process.stdout.write((c?.channels?.commonly?.accounts?.[id]?.userToken)||"");\')}"',
      '```',
      '',
    ].join('\n');
  }
  return next;
};

const migrateLegacyHeartbeatContent = (content) => {
  let next = String(content || '');
  if (!next) return next;
  next = next.replace(/\/home\/node\/\.clawdbot\/skills\/commonly\/SKILL\.md/g, './skills/commonly/SKILL.md');
  next = next.replace(/- Fetch last 20 chat messages and 10 recent posts via user-token routes: `\/api\/messages\/:podId\?limit=20` and `\/api\/posts\?podId=:podId&limit=10`\./g, '- Fetch last 20 chat messages and 10 recent posts using runtime-token routes: `/api/agents/runtime/pods/:podId/messages?limit=20` and `/api/posts?podId=:podId&limit=10`.');
  next = next.replace(/- If `commonly` skill is missing, use HTTP APIs directly \(do not run `commonly --help`\): context via `\/api\/agents\/runtime\/pods\/:podId\/context` with runtime token, or `\/api\/pods\/:podId\/context` with user token\./g, '- If `commonly` skill is missing, use HTTP APIs directly (do not run `commonly --help`) with runtime token: context via `/api/agents/runtime/pods/:podId/context`.');
  if (!/Resolve `podId` from the incoming event context/.test(next)) {
    next = next.replace(
      /- If the `commonly` skill is available, read and follow `\.\/skills\/commonly\/SKILL\.md` in this agent workspace\./,
      '- If the `commonly` skill is available, read and follow `./skills/commonly/SKILL.md` in this agent workspace.\n- Resolve `podId` from the incoming event context (usually `To: commonly:<podId>`). Do not use placeholder pod ids.',
    );
  }
  return next;
};

const resolveOpenClawAccountId = ({ agentName, instanceId }) => {
  const normalizedAgent = String(agentName || '').trim().toLowerCase();
  const normalizedInstance = String(instanceId || 'default').trim().toLowerCase() || 'default';
  if (normalizedAgent === 'openclaw') {
    return normalizedInstance;
  }
  return `${normalizedAgent}-${normalizedInstance}`;
};

const resolveOpenClawWorkspacePath = (accountId) => {
  const workspaceRoot = (
    process.env.OPENCLAW_WORKSPACE_ROOT
    || process.env.CLAWDBOT_WORKSPACE_DIR
    || '/home/node/clawd'
  ).replace(/\/+$/g, '');
  return `${workspaceRoot}/${accountId}`;
};

const writeOpenClawHeartbeatFileLocal = (accountId, content, { allowEmpty = true } = {}) => {
  const workspacePath = resolveOpenClawWorkspacePath(accountId);
  const heartbeatPath = path.join(workspacePath, 'HEARTBEAT.md');
  ensureDir(heartbeatPath);
  const normalized = allowEmpty ? String(content || '') : normalizeHeartbeatContent(content);
  fs.writeFileSync(heartbeatPath, normalized.endsWith('\n') ? normalized : `${normalized}\n`);
  chownPath(heartbeatPath);
  return heartbeatPath;
};

const ensureWorkspaceMemoryFilesLocal = (accountId) => {
  const workspacePath = resolveOpenClawWorkspacePath(accountId);
  const memoryDir = path.join(workspacePath, 'memory');
  const longTermMemoryPath = path.join(workspacePath, 'MEMORY.md');
  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = path.join(memoryDir, `${today}.md`);

  fs.mkdirSync(memoryDir, { recursive: true });
  chownPath(memoryDir);

  if (!fs.existsSync(longTermMemoryPath)) {
    const seeded = [
      '# MEMORY.md',
      '',
      'Long-term memory for this agent.',
      '- Keep durable preferences, decisions, and recurring context here.',
      '- Do not store secrets unless explicitly required.',
      '',
    ].join('\n');
    ensureDir(longTermMemoryPath);
    fs.writeFileSync(longTermMemoryPath, seeded);
    chownPath(longTermMemoryPath);
  }

  if (!fs.existsSync(dailyPath)) {
    const seededDaily = `# ${today}\n\n`;
    ensureDir(dailyPath);
    fs.writeFileSync(dailyPath, seededDaily);
    chownPath(dailyPath);
  }

  return { memoryDir, longTermMemoryPath, dailyPath };
};

const clearOpenClawSkillsDir = (accountId) => {
  const workspacePath = resolveOpenClawWorkspacePath(accountId);
  const skillsDir = path.join(workspacePath, 'skills');
  try {
    fs.rmSync(skillsDir, { recursive: true, force: true });
  } catch (error) {
    console.warn('[agent-provisioner] Failed clearing skills dir:', error.message);
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  chownPath(skillsDir);
  return skillsDir;
};

const getDefaultCommonlySkillContent = () => {
  const configuredPath = String(process.env.OPENCLAW_COMMONLY_SKILL_PATH || '').trim();
  const candidates = [
    configuredPath,
    path.resolve(__dirname, '../../external/clawdbot-state/config/skills/commonly/SKILL.md'),
    path.resolve(__dirname, '../../_external/clawdbot/skills/commonly/SKILL.md'),
  ].filter(Boolean);

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      if (content && content.trim()) return migrateLegacyCommonlySkillContent(content);
    } catch (error) {
      console.warn('[agent-provisioner] Failed loading commonly skill content:', error.message);
    }
  }

  return migrateLegacyCommonlySkillContent(DEFAULT_COMMONLY_SKILL_FALLBACK);
};

const syncOpenClawSkillsLocal = async ({
  accountId,
  podIds = [],
  mode = 'all',
  skillNames = [],
}) => {
  const skillsDir = clearOpenClawSkillsDir(accountId);
  const normalizedPods = Array.isArray(podIds)
    ? podIds.map((id) => String(id)).filter(Boolean)
    : [];
  let assets = [];
  if (normalizedPods.length) {
    const query = {
      podId: { $in: normalizedPods },
      type: 'skill',
      status: 'active',
      sourceType: 'imported-skill',
    };
    const normalizedSkillNames = Array.isArray(skillNames)
      ? skillNames.map((name) => String(name).trim()).filter(Boolean)
      : [];
    if (mode === 'selected' && normalizedSkillNames.length) {
      query['metadata.skillName'] = { $in: normalizedSkillNames };
    }
    assets = await PodAsset.find(query).lean();
  }

  const ensureDirWithMode = (dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
    chownPath(dirPath);
    try {
      fs.chmodSync(dirPath, 0o755);
    } catch (error) {
      console.warn('[agent-provisioner] Failed to chmod dir:', error.message);
    }
  };

  const setFileMode = (filePath) => {
    const lower = filePath.toLowerCase();
    const isScript = lower.includes(`${path.sep}scripts${path.sep}`)
      || lower.endsWith('.py')
      || lower.endsWith('.sh')
      || lower.endsWith('.bash');
    const mode = isScript ? 0o755 : 0o644;
    try {
      fs.chmodSync(filePath, mode);
    } catch (error) {
      console.warn('[agent-provisioner] Failed to chmod file:', error.message);
    }
    chownPath(filePath);
  };

  // Always seed commonly skill so heartbeat/checklists can rely on it in fresh workspaces.
  const defaultCommonlySkill = getDefaultCommonlySkillContent();
  if (defaultCommonlySkill && defaultCommonlySkill.trim()) {
    const commonlyDir = path.join(skillsDir, 'commonly');
    ensureDirWithMode(commonlyDir);
    const commonlySkillPath = path.join(commonlyDir, 'SKILL.md');
    fs.writeFileSync(
      commonlySkillPath,
      defaultCommonlySkill.endsWith('\n') ? defaultCommonlySkill : `${defaultCommonlySkill}\n`,
    );
    setFileMode(commonlySkillPath);
  }

  assets.forEach((asset) => {
    const skillName = asset?.metadata?.skillName || asset?.title?.replace(/^Skill:\s*/i, '') || '';
    if (!skillName) return;
    const slug = PodAssetService.normalizeSkillKey(skillName);
    const dirPath = path.join(skillsDir, slug);
    ensureDirWithMode(dirPath);
    const filePath = path.join(dirPath, 'SKILL.md');
    const content = asset?.content || '';
    fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`);
    setFileMode(filePath);

    const extraFiles = Array.isArray(asset?.metadata?.extraFiles)
      ? asset.metadata.extraFiles
      : [];
    extraFiles.forEach((file) => {
      const relPath = String(file?.path || '').trim();
      const fileContent = file?.content;
      if (!relPath || typeof fileContent !== 'string') return;
      const targetPath = path.join(dirPath, relPath);
      ensureDirWithMode(path.dirname(targetPath));
      fs.writeFileSync(targetPath, fileContent);
      setFileMode(targetPath);
    });
  });

  return skillsDir;
};

const normalizeSkillEnvMap = (env) => {
  if (!env || typeof env !== 'object') return null;
  const entries = Object.entries(env)
    .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
    .filter(([key, value]) => key && value);
  if (!entries.length) return null;
  return Object.fromEntries(entries);
};

const normalizeSkillApiKey = (value) => {
  const next = String(value ?? '').trim();
  return next ? next : null;
};

const isEnvLikeKey = (key) => /^[A-Z][A-Z0-9_]*$/.test(String(key || '').trim());

const shouldTreatRawEntryAsEnv = (rawEntry) => {
  if (!rawEntry || typeof rawEntry !== 'object') return false;
  const keys = Object.keys(rawEntry).filter(Boolean);
  return keys.length > 0 && keys.every((key) => isEnvLikeKey(key));
};

const syncOpenClawSkillEnv = ({ skillEnv = {}, configPath: overridePath } = {}) => {
  if (!skillEnv || typeof skillEnv !== 'object') return null;
  const configPath = overridePath || getOpenClawConfigPath();
  const config = readJsonFile(configPath, {});
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};

  Object.entries(skillEnv).forEach(([skillName, entry]) => {
    const skillKey = PodAssetService.normalizeSkillKey(skillName);
    const hasEnvProp = entry && typeof entry === 'object'
      ? Object.prototype.hasOwnProperty.call(entry, 'env')
      : false;
    const hasApiKeyProp = entry && typeof entry === 'object'
      ? Object.prototype.hasOwnProperty.call(entry, 'apiKey')
      : false;
    const hasRawFlag = entry && typeof entry === 'object'
      ? Object.prototype.hasOwnProperty.call(entry, '__raw') && entry.__raw === true
      : false;
    const isRawEntry = entry && typeof entry === 'object' && (!hasEnvProp && !hasApiKeyProp);
    const env = entry && typeof entry === 'object' && hasEnvProp ? entry.env : entry;
    const apiKey = entry && typeof entry === 'object' ? entry.apiKey : null;
    const rawEntry = isRawEntry
      ? Object.fromEntries(
        Object.entries(entry)
          .map(([key, value]) => [String(key || '').trim(), value])
          .filter(([key]) => key),
      )
      : null;
    const normalizedEnv = normalizeSkillEnvMap(env);
    const normalizedApiKey = normalizeSkillApiKey(apiKey);
    if (!normalizedEnv && !normalizedApiKey && (!rawEntry || !Object.keys(rawEntry).length)) {
      if (config.skills.entries[skillKey]) {
        delete config.skills.entries[skillKey].env;
        if (hasApiKeyProp) {
          delete config.skills.entries[skillKey].apiKey;
        }
        if (!Object.keys(config.skills.entries[skillKey]).length) {
          delete config.skills.entries[skillKey];
        }
      }
      return;
    }
    if (hasRawFlag) {
      const cleaned = Object.fromEntries(
        Object.entries(entry || {})
          .filter(([key]) => key && key !== '__raw')
          .map(([key, value]) => [String(key || '').trim(), value]),
      );
      if (!Object.keys(cleaned).length) {
        delete config.skills.entries[skillKey];
        return;
      }
      config.skills.entries[skillKey] = cleaned;
      return;
    }
    if (rawEntry && Object.keys(rawEntry).length) {
      if (shouldTreatRawEntryAsEnv(rawEntry)) {
        config.skills.entries[skillKey] = {
          ...(config.skills.entries[skillKey] || {}),
          env: normalizeSkillEnvMap(rawEntry) || {},
        };
        return;
      }
      config.skills.entries[skillKey] = rawEntry;
      return;
    }
    config.skills.entries[skillKey] = {
      ...(config.skills.entries[skillKey] || {}),
      ...(normalizedEnv ? { env: normalizedEnv } : {}),
      ...(normalizedApiKey ? { apiKey: normalizedApiKey } : {}),
    };
    if (hasApiKeyProp && !normalizedApiKey) {
      delete config.skills.entries[skillKey].apiKey;
    }
  });

  writeJsonFile(configPath, config);
  return configPath;
};

const readGatewaySkillEntries = ({ configPath: overridePath } = {}) => {
  const configPath = overridePath || getOpenClawConfigPath();
  const config = readJsonFile(configPath, {});
  const entries = config?.skills?.entries || {};
  const output = {};
  Object.entries(entries).forEach(([skillKey, entry]) => {
    const env = entry?.env || {};
    const keys = Object.keys(env).filter(Boolean);
    const rawKeys = Object.keys(entry || {}).filter(
      (key) => key && key !== 'env' && key !== 'apiKey',
    );
    const merged = Array.from(new Set([...keys, ...rawKeys]));
    output[skillKey] = {
      envKeys: merged,
      apiKeyPresent: Boolean(entry?.apiKey),
      rawKeys,
    };
  });
  return output;
};

const getGatewaySkillEntries = async ({ gateway } = {}) => {
  if (isK8sMode() || gateway?.mode === 'k8s') {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.getGatewaySkillEntries({ gateway });
  }
  return readGatewaySkillEntries({ configPath: gateway?.configPath });
};

const syncGatewaySkillEnv = async ({ gateway, entries } = {}) => {
  if (isK8sMode() || gateway?.mode === 'k8s') {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.syncGatewaySkillEnv({ gateway, entries });
  }
  syncOpenClawSkillEnv({ skillEnv: entries, configPath: gateway?.configPath });
  return readGatewaySkillEntries({ configPath: gateway?.configPath });
};

const ensureHeartbeatTemplate = (accountId, heartbeat) => {
  if (!heartbeat || heartbeat.enabled === false) return null;
  const workspacePath = resolveOpenClawWorkspacePath(accountId);
  const heartbeatPath = path.join(workspacePath, 'HEARTBEAT.md');
  let content = '';
  try {
    if (fs.existsSync(heartbeatPath)) {
      content = fs.readFileSync(heartbeatPath, 'utf8');
    }
  } catch (error) {
    console.warn('[agent-provisioner] Failed to read HEARTBEAT.md:', error.message);
  }
  if (!content || isHeartbeatContentEffectivelyEmpty(content)) {
    const normalized = normalizeHeartbeatContent(DEFAULT_HEARTBEAT_CONTENT);
    ensureDir(heartbeatPath);
    fs.writeFileSync(heartbeatPath, normalized);
    chownPath(heartbeatPath);
    return heartbeatPath;
  }
  const migrated = migrateLegacyHeartbeatContent(content);
  if (migrated !== content) {
    const normalized = normalizeHeartbeatContent(migrated);
    ensureDir(heartbeatPath);
    fs.writeFileSync(heartbeatPath, normalized);
    chownPath(heartbeatPath);
  }
  return heartbeatPath;
};

const getOpenClawConfigPath = () => (
  process.env.OPENCLAW_CONFIG_PATH
  || path.resolve(__dirname, '../../external/clawdbot-state/config/moltbot.json')
);

const getCommonlyBotConfigPath = () => (
  process.env.COMMONLY_BOT_CONFIG_PATH
  || path.resolve(__dirname, '../../external/commonly-bot-state/runtime.json')
);

const applyOpenClawIntegrationChannels = (config, integrationChannels) => {
  if (!integrationChannels || typeof integrationChannels !== 'object') return;
  config.channels = config.channels || {};

  const defaultDiscordToken = String(process.env.DISCORD_BOT_TOKEN || '').trim();
  if (defaultDiscordToken) {
    config.channels.discord = config.channels.discord || {};
    config.channels.discord.token = config.channels.discord.token || defaultDiscordToken;
  }
  const defaultSlackBotToken = String(process.env.SLACK_BOT_TOKEN || '').trim();
  const defaultSlackAppToken = String(process.env.SLACK_APP_TOKEN || '').trim();
  const defaultSlackSigningSecret = String(process.env.SLACK_SIGNING_SECRET || '').trim();
  if (defaultSlackBotToken || defaultSlackAppToken || defaultSlackSigningSecret) {
    config.channels.slack = config.channels.slack || {};
    if (defaultSlackBotToken) {
      config.channels.slack.botToken = config.channels.slack.botToken || defaultSlackBotToken;
    }
    if (defaultSlackAppToken) {
      config.channels.slack.appToken = config.channels.slack.appToken || defaultSlackAppToken;
    }
    if (defaultSlackSigningSecret) {
      config.channels.slack.signingSecret = (
        config.channels.slack.signingSecret || defaultSlackSigningSecret
      );
    }
  }
  const defaultTelegramBotToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const defaultTelegramSecret = String(process.env.TELEGRAM_SECRET_TOKEN || '').trim();
  if (defaultTelegramBotToken || defaultTelegramSecret) {
    config.channels.telegram = config.channels.telegram || {};
    if (defaultTelegramBotToken) {
      config.channels.telegram.botToken = (
        config.channels.telegram.botToken || defaultTelegramBotToken
      );
    }
    if (defaultTelegramSecret) {
      config.channels.telegram.webhookSecret = (
        config.channels.telegram.webhookSecret || defaultTelegramSecret
      );
    }
  }

  const asEntries = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        accountId: String(entry.accountId || '').trim(),
        ...entry,
      }))
      .filter((entry) => entry.accountId);
  };

  const discordAccounts = asEntries(integrationChannels.discord);
  if (discordAccounts.length) {
    config.channels.discord = config.channels.discord || {};
    config.channels.discord.accounts = config.channels.discord.accounts || {};
    discordAccounts.forEach((entry) => {
      const token = String(entry.token || '').trim();
      if (!token) return;
      const existing = config.channels.discord.accounts[entry.accountId] || {};
      config.channels.discord.accounts[entry.accountId] = {
        ...existing,
        ...(entry.name ? { name: entry.name } : {}),
        token,
      };
      if (!config.channels.discord.token) {
        config.channels.discord.token = token;
      }
    });
  }

  const slackAccounts = asEntries(integrationChannels.slack);
  if (slackAccounts.length) {
    config.channels.slack = config.channels.slack || {};
    config.channels.slack.accounts = config.channels.slack.accounts || {};
    slackAccounts.forEach((entry) => {
      const botToken = String(entry.botToken || '').trim();
      if (!botToken) return;
      const existing = config.channels.slack.accounts[entry.accountId] || {};
      config.channels.slack.accounts[entry.accountId] = {
        ...existing,
        ...(entry.name ? { name: entry.name } : {}),
        botToken,
        ...(entry.appToken ? { appToken: entry.appToken } : {}),
        ...(entry.signingSecret ? { signingSecret: entry.signingSecret } : {}),
        ...(entry.channelId ? { channels: { [entry.channelId]: { enabled: true } } } : {}),
      };
      if (!config.channels.slack.botToken) {
        config.channels.slack.botToken = botToken;
      }
      if (!config.channels.slack.appToken && entry.appToken) {
        config.channels.slack.appToken = entry.appToken;
      }
      if (!config.channels.slack.signingSecret && entry.signingSecret) {
        config.channels.slack.signingSecret = entry.signingSecret;
      }
    });
  }

  const telegramAccounts = asEntries(integrationChannels.telegram);
  if (telegramAccounts.length) {
    config.channels.telegram = config.channels.telegram || {};
    config.channels.telegram.accounts = config.channels.telegram.accounts || {};
    telegramAccounts.forEach((entry) => {
      const botToken = String(entry.botToken || '').trim();
      if (!botToken) return;
      const existing = config.channels.telegram.accounts[entry.accountId] || {};
      config.channels.telegram.accounts[entry.accountId] = {
        ...existing,
        ...(entry.name ? { name: entry.name } : {}),
        botToken,
        ...(entry.webhookSecret ? { webhookSecret: entry.webhookSecret } : {}),
        ...(entry.chatId ? { groups: { [entry.chatId]: { enabled: true } } } : {}),
      };
      if (!config.channels.telegram.botToken) {
        config.channels.telegram.botToken = botToken;
      }
      if (!config.channels.telegram.webhookSecret && entry.webhookSecret) {
        config.channels.telegram.webhookSecret = entry.webhookSecret;
      }
    });
  }
};

const applyOpenClawWebToolDefaults = (config) => {
  const braveApiKey = String(process.env.BRAVE_API_KEY || '').trim();
  const firecrawlApiKey = String(process.env.FIRECRAWL_API_KEY || '').trim();
  if (!braveApiKey && !firecrawlApiKey) return;
  config.tools = config.tools || {};
  config.tools.web = config.tools.web || {};
  if (braveApiKey) {
    config.tools.web.search = config.tools.web.search || {};
    if (!config.tools.web.search.provider) {
      config.tools.web.search.provider = 'brave';
    }
    if (!config.tools.web.search.apiKey) {
      config.tools.web.search.apiKey = braveApiKey;
    }
    if (config.tools.web.search.enabled === undefined) {
      config.tools.web.search.enabled = true;
    }
  }
  if (firecrawlApiKey) {
    config.tools.web.fetch = config.tools.web.fetch || {};
    config.tools.web.fetch.firecrawl = config.tools.web.fetch.firecrawl || {};
    if (!config.tools.web.fetch.firecrawl.apiKey) {
      config.tools.web.fetch.firecrawl.apiKey = firecrawlApiKey;
    }
    if (config.tools.web.fetch.firecrawl.enabled === undefined) {
      config.tools.web.fetch.firecrawl.enabled = true;
    }
  }
};

const provisionOpenClawAccount = ({
  accountId,
  runtimeToken,
  userToken,
  agentName,
  instanceId,
  baseUrl,
  displayName,
  heartbeat,
  authProfiles,
  integrationChannels,
}) => {
  const configPath = getOpenClawConfigPath();
  const config = readJsonFile(configPath, {});

  config.channels = config.channels || {};
  config.channels.commonly = config.channels.commonly || {};
  config.channels.commonly.enabled = true;
  config.channels.commonly.baseUrl = config.channels.commonly.baseUrl || baseUrl;
  config.channels.commonly.accounts = config.channels.commonly.accounts || {};

  const existingAccount = config.channels.commonly.accounts[accountId] || {};
  const resolvedRuntimeToken = runtimeToken || existingAccount.runtimeToken;
  const resolvedUserToken = userToken || existingAccount.userToken;
  if (!resolvedRuntimeToken) {
    throw new Error('Missing runtime token for OpenClaw account provisioning');
  }

  const normalizeKey = (value, fallback) => {
    const normalized = String(value ?? fallback ?? '').trim().toLowerCase();
    return normalized || String(fallback || '').trim().toLowerCase();
  };
  const targetAgent = normalizeKey(agentName, '');
  const targetInstance = normalizeKey(instanceId, 'default');
  const removedAccountIds = [];

  Object.entries(config.channels.commonly.accounts).forEach(([key, entry]) => {
    if (!entry || key === accountId) return;
    const entryAgent = normalizeKey(entry.agentName, '');
    const entryInstance = normalizeKey(entry.instanceId, 'default');
    if (entryAgent === targetAgent && entryInstance === targetInstance) {
      delete config.channels.commonly.accounts[key];
      removedAccountIds.push(key);
    }
  });

  config.channels.commonly.accounts[accountId] = {
    runtimeToken: resolvedRuntimeToken,
    userToken: resolvedUserToken,
    agentName,
    instanceId,
    ...(authProfiles ? { authProfiles } : {}),
  };
  applyOpenClawIntegrationChannels(config, integrationChannels);
  applyOpenClawWebToolDefaults(config);

  config.agents = config.agents || {};
  config.agents.list = Array.isArray(config.agents.list) ? config.agents.list : [];
  if (removedAccountIds.length) {
    config.agents.list = config.agents.list.filter(
      (agent) => !removedAccountIds.includes(agent?.id),
    );
  }
  const desiredWorkspace = resolveOpenClawWorkspacePath(accountId);
  const normalizeHeartbeat = (payload) => {
    if (!payload || payload.enabled === false) return null;
    const minutes = Number(payload.everyMinutes || payload.every || payload.intervalMinutes);
    const every = Number.isFinite(minutes) && minutes > 0 ? `${minutes}m` : payload.every;
    return {
      every: every || '30m', // 30 min default (matches OpenClaw default)
      prompt: payload.prompt || undefined,
      target: payload.target || 'commonly', // Default to Commonly for Commonly-installed agents
      session: payload.session || undefined,
    };
  };

  const agentEntry = config.agents.list.find((agent) => agent?.id === accountId);
  const heartbeatConfig = normalizeHeartbeat(heartbeat);
  if (agentEntry) {
    if (agentEntry.workspace !== desiredWorkspace) {
      agentEntry.workspace = desiredWorkspace;
    }
    if (!agentEntry.name) {
      agentEntry.name = displayName || agentName || accountId;
    }
    if (heartbeatConfig) {
      agentEntry.heartbeat = heartbeatConfig;
    } else if (agentEntry.heartbeat) {
      delete agentEntry.heartbeat;
    }
  } else {
    config.agents.list.push({
      id: accountId,
      name: displayName || agentName || accountId,
      workspace: desiredWorkspace,
      ...(heartbeatConfig ? { heartbeat: heartbeatConfig } : {}),
    });
  }

  config.bindings = Array.isArray(config.bindings) ? config.bindings : [];
  if (removedAccountIds.length) {
    config.bindings = config.bindings.filter(
      (binding) => !removedAccountIds.includes(binding?.match?.accountId),
    );
  }
  const bindingExists = config.bindings.some(
    (binding) => binding?.match?.channel === 'commonly' && binding?.match?.accountId === accountId,
  );
  if (!bindingExists) {
    config.bindings.push({
      agentId: accountId,
      match: { channel: 'commonly', accountId },
    });
  }

  writeJsonFile(configPath, config);
  ensureHeartbeatTemplate(accountId, heartbeat);
  ensureWorkspaceMemoryFilesLocal(accountId);

  return {
    configPath,
    accountId,
    restartRequired: true,
  };
};

const provisionCommonlyBotAccount = ({
  accountId,
  runtimeToken,
  userToken,
  agentName,
  instanceId,
}) => {
  const configPath = getCommonlyBotConfigPath();
  const config = readJsonFile(configPath, { accounts: {} });
  config.accounts = config.accounts || {};
  config.accounts[accountId] = {
    runtimeToken,
    userToken,
    agentName,
    instanceId,
  };

  writeJsonFile(configPath, config);

  return {
    configPath,
    accountId,
    restartRequired: false,
  };
};

const provisionAgentRuntime = async ({
  runtimeType,
  agentName,
  instanceId,
  runtimeToken,
  userToken,
  baseUrl,
  displayName,
  heartbeat,
  authProfiles,
  skillEnv,
  integrationChannels,
}) => {
  // Route to K8s or Docker implementation
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.provisionAgentRuntime({
      runtimeType,
      agentName,
      instanceId,
      runtimeToken,
      userToken,
      baseUrl,
      displayName,
      heartbeat,
      authProfiles,
      skillEnv,
      integrationChannels,
    });
  }

  // Docker mode (existing file-based logic)
  if (runtimeType === 'moltbot') {
    const accountId = resolveOpenClawAccountId({ agentName, instanceId });
    const result = provisionOpenClawAccount({
      accountId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
      baseUrl,
      displayName,
      heartbeat,
      authProfiles,
      integrationChannels,
    });
    if (skillEnv) {
      syncOpenClawSkillEnv({ skillEnv, configPath: getOpenClawConfigPath() });
    }
    return result;
  }

  if (runtimeType === 'internal') {
    return provisionCommonlyBotAccount({
      accountId: instanceId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
    });
  }

  throw new Error(`Provisioning not supported for runtime: ${runtimeType}`);
};

const isDockerProvisioningEnabled = () => process.env.AGENT_PROVISIONER_DOCKER === '1';

const getComposeFile = () => (
  process.env.AGENT_PROVISIONER_DOCKER_COMPOSE_FILE
  || path.resolve(__dirname, '../../docker-compose.dev.yml')
);

const buildComposeCommand = (args) => {
  const composeBin = process.env.DOCKER_COMPOSE_BIN;
  if (composeBin) {
    return { bin: composeBin, args };
  }
  const bin = process.env.DOCKER_BIN || 'docker';
  return { bin, args: ['compose', ...args] };
};

const getDockerBin = () => process.env.DOCKER_BIN || 'docker';

const execDockerCommand = async (args, options = {}) => {
  const bin = getDockerBin();
  const result = await execFileAsync(bin, args, {
    timeout: options.timeout ?? 120000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: `${bin} ${args.join(' ')}`,
  };
};

const resolveContainerName = (runtimeType) => {
  if (runtimeType === 'moltbot') return 'clawdbot-gateway-dev';
  if (runtimeType === 'internal') return 'commonly-bot-dev';
  return null;
};

const dockerContainerExists = async (containerName) => {
  if (!containerName) return false;
  try {
    const result = await execDockerCommand([
      'ps',
      '-a',
      '--filter',
      `name=^/${containerName}$`,
      '--format',
      '{{.ID}}',
    ], { timeout: 10000 });
    return Boolean(result.stdout.trim());
  } catch (error) {
    return false;
  }
};

const execDockerRuntimeCommand = async (runtimeType, args, options = {}) => {
  if (!isDockerProvisioningEnabled()) {
    throw new Error('docker provisioning disabled');
  }
  const containerName = resolveContainerName(runtimeType);
  if (!containerName) {
    throw new Error(`unsupported runtime: ${runtimeType}`);
  }
  const result = await execDockerCommand(['exec', '-T', containerName, ...args], options);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: result.command,
    service: containerName,
  };
};

const listOpenClawPluginsDocker = async () => {
  const result = await execDockerRuntimeCommand('moltbot', [
    'node',
    'dist/index.js',
    'plugins',
    'list',
    '--json',
  ], { timeout: 30_000 });
  let payload;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new Error('Failed to parse OpenClaw plugin list output.');
  }
  return {
    ...payload,
    command: result.command,
    service: result.service,
  };
};

const installOpenClawPluginDocker = async ({ spec, link = false }) => {
  const args = [
    'node',
    'dist/index.js',
    'plugins',
    'install',
    spec,
  ];
  if (link) {
    args.push('--link');
  }
  return execDockerRuntimeCommand('moltbot', args);
};

const listOpenClawBundledSkillsDocker = async () => {
  const candidates = [
    '/app/skills',
    path.resolve(__dirname, '../../_external/clawdbot/skills'),
  ];
  const skillsDir = candidates.find((candidate) => fs.existsSync(candidate));
  if (!skillsDir) {
    return { skills: [] };
  }
  const names = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^[a-zA-Z0-9._-]+$/.test(name))
    .sort((a, b) => a.localeCompare(b));
  return {
    skills: names.map((name) => ({ name })),
    path: skillsDir,
  };
};

const resolveDockerServiceName = (runtimeType) => {
  if (runtimeType === 'moltbot') return 'clawdbot-gateway';
  if (runtimeType === 'internal') return 'commonly-bot';
  return null;
};

const startDockerRuntime = async (runtimeType) => {
  if (!isDockerProvisioningEnabled()) {
    return { started: false, reason: 'docker provisioning disabled' };
  }

  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand(['start', containerName], { timeout: 30_000 });
    return { started: true, command: result.command, container: containerName };
  }

  const composeFile = getComposeFile();
  let args = ['-f', composeFile];

  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { started: false, reason: `unsupported runtime: ${runtimeType}` };
  }
  if (runtimeType === 'moltbot') {
    args = args.concat(['--profile', 'clawdbot', 'up', '-d', serviceName]);
  } else {
    args = args.concat(['up', '-d', serviceName]);
  }

  const command = buildComposeCommand(args);
  await execFileAsync(command.bin, command.args, { timeout: 60_000 });
  return { started: true, command: `${command.bin} ${command.args.join(' ')}` };
};

const stopDockerRuntime = async (runtimeType) => {
  if (!isDockerProvisioningEnabled()) {
    return { stopped: false, reason: 'docker provisioning disabled' };
  }
  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand(['stop', containerName], { timeout: 30_000 });
    return { stopped: true, command: result.command, container: containerName };
  }
  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { stopped: false, reason: `unsupported runtime: ${runtimeType}` };
  }
  const composeFile = getComposeFile();
  const args = ['-f', composeFile, 'stop', serviceName];
  const command = buildComposeCommand(args);
  await execFileAsync(command.bin, command.args, { timeout: 60_000 });
  return { stopped: true, command: `${command.bin} ${command.args.join(' ')}` };
};

const restartDockerRuntime = async (runtimeType) => {
  if (!isDockerProvisioningEnabled()) {
    return { restarted: false, reason: 'docker provisioning disabled' };
  }
  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand(['restart', containerName], { timeout: 30_000 });
    return { restarted: true, command: result.command, container: containerName };
  }
  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { restarted: false, reason: `unsupported runtime: ${runtimeType}` };
  }
  const composeFile = getComposeFile();
  const args = ['-f', composeFile, 'restart', serviceName];
  const command = buildComposeCommand(args);
  await execFileAsync(command.bin, command.args, { timeout: 60_000 });
  return { restarted: true, command: `${command.bin} ${command.args.join(' ')}` };
};

const getDockerRuntimeStatus = async (runtimeType) => {
  if (!isDockerProvisioningEnabled()) {
    return { status: 'disabled', reason: 'docker provisioning disabled' };
  }
  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand([
      'inspect',
      '-f',
      '{{.State.Status}}',
      containerName,
    ], { timeout: 10_000 });
    return {
      status: result.stdout.trim() || 'unknown',
      service: containerName,
    };
  }
  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { status: 'unknown', reason: `unsupported runtime: ${runtimeType}` };
  }
  const composeFile = getComposeFile();
  const args = ['-f', composeFile, 'ps', '--format', 'json', serviceName];
  const command = buildComposeCommand(args);
  const result = await execFileAsync(command.bin, command.args, { timeout: 20_000 });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch (error) {
    parsed = [];
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry) {
    return { status: 'stopped', service: serviceName };
  }
  return {
    status: entry.State || entry.Status || 'unknown',
    service: serviceName,
    containerId: entry.ID,
    name: entry.Name,
  };
};

const getDockerRuntimeLogs = async (runtimeType, lines = 200) => {
  if (!isDockerProvisioningEnabled()) {
    return { logs: '', reason: 'docker provisioning disabled' };
  }
  const containerName = resolveContainerName(runtimeType);
  if (containerName && await dockerContainerExists(containerName)) {
    const result = await execDockerCommand(
      ['logs', '--tail', String(lines), containerName],
      { timeout: 20_000 },
    );
    return { logs: result.stdout || '', service: containerName };
  }
  const serviceName = resolveDockerServiceName(runtimeType);
  if (!serviceName) {
    return { logs: '', reason: `unsupported runtime: ${runtimeType}` };
  }
  const composeFile = getComposeFile();
  const args = ['-f', composeFile, 'logs', '--no-color', '--tail', String(lines), serviceName];
  const command = buildComposeCommand(args);
  const result = await execFileAsync(command.bin, command.args, { timeout: 20_000 });
  return { logs: result.stdout || '', service: serviceName };
};

// Kubernetes mode detection
const isK8sMode = () => process.env.AGENT_PROVISIONER_K8S === '1';

const syncOpenClawSkills = async (options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.syncOpenClawSkills({
      ...options,
      defaultCommonlySkillContent: getDefaultCommonlySkillContent(),
    });
  }
  return syncOpenClawSkillsLocal(options);
};

const writeOpenClawHeartbeatFile = async (accountId, content, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.writeOpenClawHeartbeatFile(accountId, content, options);
  }
  return writeOpenClawHeartbeatFileLocal(accountId, content, options);
};

// Unified interface that routes to K8s or Docker implementation
const startAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.startAgentRuntime(runtimeType, instanceId, options);
  }
  return startDockerRuntime(runtimeType);
};

const stopAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.stopAgentRuntime(runtimeType, instanceId, options);
  }
  return stopDockerRuntime(runtimeType);
};

const restartAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.restartAgentRuntime(runtimeType, instanceId, options);
  }
  return restartDockerRuntime(runtimeType);
};

const getAgentRuntimeStatus = async (runtimeType, instanceId, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.getAgentRuntimeStatus(runtimeType, instanceId, options);
  }
  return getDockerRuntimeStatus(runtimeType);
};

const getAgentRuntimeLogs = async (runtimeType, instanceId, lines = 200, options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.getAgentRuntimeLogs(runtimeType, instanceId, lines, options);
  }
  return getDockerRuntimeLogs(runtimeType, lines);
};

const listOpenClawPlugins = async (options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.listOpenClawPlugins(options);
  }
  return listOpenClawPluginsDocker();
};

const listOpenClawBundledSkills = async (options = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.listOpenClawBundledSkills(options);
  }
  return listOpenClawBundledSkillsDocker();
};

const installOpenClawPlugin = async ({ spec, link = false, ...options } = {}) => {
  if (isK8sMode()) {
    // eslint-disable-next-line global-require
    const k8sProvisioner = require('./agentProvisionerServiceK8s');
    return k8sProvisioner.installOpenClawPlugin({ spec, link, ...options });
  }
  return installOpenClawPluginDocker({ spec, link });
};

// Export unified interface
module.exports = {
  // Core provisioning (works in both modes)
  provisionAgentRuntime,
  getOpenClawConfigPath,
  getCommonlyBotConfigPath,

  // Unified runtime control (auto-routes to K8s or Docker)
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,

  // Docker-specific exports (deprecated, use unified interface)
  startDockerRuntime,
  stopDockerRuntime,
  restartDockerRuntime,
  getDockerRuntimeStatus,
  getDockerRuntimeLogs,
  resolveDockerServiceName,
  execDockerRuntimeCommand,
  listOpenClawPlugins,
  listOpenClawBundledSkills,
  installOpenClawPlugin,
  writeOpenClawHeartbeatFile,
  ensureHeartbeatTemplate,
  syncOpenClawSkills,
  syncOpenClawSkillEnv,
  getGatewaySkillEntries,
  syncGatewaySkillEnv,

  // Mode detection
  isK8sMode,
};
