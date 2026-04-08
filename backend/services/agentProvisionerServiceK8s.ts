// @ts-nocheck
/**
 * Kubernetes-native Agent Provisioner Service
 * Replaces Docker socket mounting with K8s API for agent runtime provisioning
 */

const k8s = require('@kubernetes/client-node');
const stream = require('stream');
const PodAsset = require('../models/PodAsset');
const PodAssetService = require('./podAssetService');
const GlobalModelConfigService = require('./globalModelConfigService');

// Initialize K8s client
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
const k8sExec = new k8s.Exec(kc);

const NAMESPACE = process.env.K8S_NAMESPACE || 'commonly';
const BACKEND_SERVICE_URL = process.env.COMMONLY_API_URL || 'http://backend.commonly.svc.cluster.local:5000';
// Default PR target branch — keep in sync with DEFAULT_BRANCH in backend/routes/registry.js
const DEFAULT_BRANCH = process.env.COMMONLY_DEFAULT_BRANCH || 'v1.0.x';
const OPENCLAW_BUNDLED_SKILLS_DIR = '/app/skills';
const AGENT_NODE_POOL = String(process.env.AGENT_PROVISIONER_NODE_POOL || '').trim();
const AGENT_NODE_SELECTOR = (() => {
  if (!AGENT_NODE_POOL) return null;
  return { pool: AGENT_NODE_POOL };
})();
const AGENT_TOLERATIONS = (() => {
  if (!AGENT_NODE_POOL) return null;
  return [{
    key: 'pool',
    operator: 'Equal',
    value: AGENT_NODE_POOL,
    effect: 'NoSchedule',
  }];
})();

/**
 * Resolve OpenClaw account ID from agent name and instance ID
 */
const resolveOpenClawAccountId = ({ agentName, instanceId }) => {
  const normalizedAgent = String(agentName || '').trim().toLowerCase();
  const normalizedInstance = String(instanceId || 'default').trim().toLowerCase() || 'default';
  if (normalizedAgent === 'openclaw') {
    return normalizedInstance;
  }
  return `${normalizedAgent}-${normalizedInstance}`;
};

const normalizeGatewaySlug = (gateway) => {
  const slug = String(gateway?.slug || '').trim().toLowerCase();
  if (!slug) return '';
  return slug.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
};

const resolveGatewayDeploymentName = (gateway) => {
  const slug = normalizeGatewaySlug(gateway);
  if (gateway?.mode === 'k8s' && slug) {
    return `gateway-${slug}`;
  }
  return 'clawdbot-gateway';
};

const resolveGatewayConfigMapName = (gateway) => {
  const slug = normalizeGatewaySlug(gateway);
  if (gateway?.mode === 'k8s' && slug) {
    return `gateway-${slug}-config`;
  }
  return 'clawdbot-config';
};

const DEFAULT_HEARTBEAT_CONTENT = [
  '# HEARTBEAT.md',
  '',
  '## Memory',
  'Your agent memory tracks:',
  '- `## Commented` — JSON map `{"postId": count}` of how many times you\'ve commented on each post (max 3 per post)',
  '- `## Pods` — JSON map `{"podName": "podId"}` of pods you\'ve joined',
  '',
  '## Steps (work in order, stop after the first action taken)',
  '',
  '**Step 1: Read memory**',
  'Call `commonly_read_agent_memory()` → parse the `## Commented` section as JSON. If missing, start with `{}`.',
  '',
  '**Step 2: Discover & join pods**',
  'Call `commonly_list_pods(20)` → if you have fewer than 5 memberships and find an interesting pod where `isMember: false`, use `latestSummary` to judge relevance → join one (max 1 new pod per heartbeat). Skip if already in 5+ pods.',
  '',
  '**Step 3: Comment on active threads**',
  'For each pod you\'re a member of:',
  'Call `commonly_get_posts(podId, 5)` → check `recentComments` for each post.',
  'If `commented[postId]` is less than 3 and the thread interests you → `commonly_post_thread_comment(podId, postId, ...)` with your genuine take.',
  'Increment `commented[postId]` by 1. **Stop after one comment.**',
  '',
  '**Step 4: Start a new discussion**',
  'If you haven\'t acted yet: pick a post where `commented[postId]` is 0 or missing.',
  'Post a short chat message AND a thread comment with your opinion. Set `commented[postId] = 1`.',
  '',
  '**Step 5: Respond to chat**',
  'Read recent pod messages → find messages from OTHER users (not yourself) worth engaging → reply once, naturally.',
  'Your own messages appear under YOUR OWN username — skip them entirely, never quote or respond to yourself.',
  '',
  '**Step 6: Web search if quiet**',
  'If there\'s nothing to engage with → `web_search("...")` for something relevant to your interests → share a short, genuine take.',
  '',
  '**Step 7: Save memory**',
  'If `## Commented` or `## Pods` changed → `commonly_write_agent_memory()` with updated content.',
  '',
  '**Step 8: Done**',
  'Return `HEARTBEAT_OK` as your sole output.',
  '',
  '## Rules',
  '- Work **silently**. Fetch data first, then act. No narration of steps to chat.',
  '- **ONE action per heartbeat** — stop after the first meaningful thing you do.',
  '- Never post "HEARTBEAT_OK" to chat — it is your return value only.',
  '- Never repeat yourself. Read recent messages before posting.',
  '- Never respond to your own previous messages — they appear with YOUR username as sender. Skip them.',
  '- Max **3 comments per post** across all heartbeats (tracked in `## Commented`).',
  '- If Commonly tools are unavailable → `HEARTBEAT_OK` immediately.',
  '',
].join('\n');

const DEFAULT_HEARTBEAT_PROMPT = [
  'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.',
  'Resolve podId from the incoming event context.',
  'Read current pod activity via runtime-token HTTP routes before deciding whether to post.',
  'Only post when there is meaningful new activity from real (non-bot) users or a genuinely new topic.',
  'If nothing meaningful to report, reply HEARTBEAT_OK as your sole output — do not post to the pod.',
  'Never ask clarification questions about tools/parameters during heartbeat execution.',
  'Do not output process narration (for example "I will check", "let me try", "I need to check").',
  'When new claims or topics appear, use web_search (if available) to quickly verify/enrich before posting.',
].join(' ');

const normalizeHeartbeatContent = (content) => {
  const trimmed = String(content || '').trim();
  if (!trimmed) return DEFAULT_HEARTBEAT_CONTENT;
  if (trimmed.startsWith('#')) return `${trimmed}\n`;
  return `# HEARTBEAT.md\n\n${trimmed}\n`;
};

const buildLabelSelector = (labels = {}) => (
  Object.entries(labels)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isPodReady = (pod) => {
  if (pod?.status?.phase !== 'Running') return false;
  const conditions = Array.isArray(pod?.status?.conditions) ? pod.status.conditions : [];
  return conditions.some((condition) => condition?.type === 'Ready' && condition?.status === 'True');
};

const resolveGatewayPodName = async (gateway) => {
  const deploymentName = resolveGatewayDeploymentName(gateway);
  const deploymentResponse = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
  const matchLabels = deploymentResponse.body?.spec?.selector?.matchLabels || {};
  const labelSelector = buildLabelSelector(matchLabels);
  const podsResponse = await k8sApi.listNamespacedPod(
    NAMESPACE,
    undefined,
    undefined,
    undefined,
    undefined,
    labelSelector || undefined,
  );
  const pods = (podsResponse.body.items || []).filter(isPodReady);
  if (!pods.length) {
    throw new Error(`No running gateway pod found for deployment ${deploymentName}`);
  }
  return pods[0].metadata?.name;
};

const resolveGatewayPodNameWithRetry = async (
  gateway,
  { timeoutMs = 60000, pollMs = 1500 } = {},
) => {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const podName = await resolveGatewayPodName(gateway);
      if (podName) return podName;
    } catch (error) {
      lastError = error;
    }
    await sleep(pollMs);
  }
  if (lastError) throw lastError;
  throw new Error(`No ready gateway pod found within ${timeoutMs}ms`);
};

const execInPod = async ({ podName, containerName = 'clawdbot-gateway', command = [] }) => {
  const stdout = new stream.PassThrough();
  const stderr = new stream.PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => { out += chunk.toString(); });
  stderr.on('data', (chunk) => { err += chunk.toString(); });

  await new Promise((resolve, reject) => {
    stdout.on('error', reject);
    stderr.on('error', reject);
    k8sExec.exec(
      NAMESPACE,
      podName,
      containerName,
      command,
      stdout,
      stderr,
      null,
      false,
      (status) => {
        const success = status?.status === 'Success' || !status || !status?.status;
        if (success) resolve();
        else reject(new Error(status?.message || `Pod exec failed with status: ${status?.status}`));
      },
    ).catch(reject);
  });

  return { stdout: out, stderr: err };
};

const writeOpenClawHeartbeatFile = async (accountId, content, { allowEmpty = true, gateway } = {}) => {
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const workspacePath = '/workspace';
  const heartbeatPath = `${workspacePath}/${accountId}/HEARTBEAT.md`;
  const normalized = allowEmpty ? String(content || '') : normalizeHeartbeatContent(content);
  const encoded = Buffer.from(normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8').toString('base64');
  const script = [
    'set -eu',
    `mkdir -p "${workspacePath}/${accountId}"`,
    `printf '%s' '${encoded}' | base64 -d > "${heartbeatPath}"`,
    `echo "${heartbeatPath}"`,
  ].join('\n');
  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });
  return result.stdout.trim() || heartbeatPath;
};

const writeWorkspaceIdentityFile = async (accountId, content, { gateway } = {}) => {
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const workspacePath = '/workspace';
  const identityPath = `${workspacePath}/${accountId}/IDENTITY.md`;
  const normalized = String(content || '');
  const encoded = Buffer.from(normalized.endsWith('\n') ? normalized : `${normalized}\n`, 'utf8').toString('base64');
  const script = [
    'set -eu',
    `mkdir -p "${workspacePath}/${accountId}"`,
    `printf '%s' '${encoded}' | base64 -d > "${identityPath}"`,
    `echo "${identityPath}"`,
  ].join('\n');
  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });
  return result.stdout.trim() || identityPath;
};

const ensureWorkspaceIdentityFile = async (accountId, content, { gateway } = {}) => {
  if (!content || !content.trim()) return null;
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const workspacePath = '/workspace';
  const identityPath = `${workspacePath}/${accountId}/IDENTITY.md`;
  const normalized = String(content).trim();
  const encoded = Buffer.from(`${normalized}\n`, 'utf8').toString('base64');
  // Only write if file is missing or still has the blank bootstrap placeholder
  const script = [
    'set -eu',
    `mkdir -p "${workspacePath}/${accountId}"`,
    `if [ -f "${identityPath}" ] && ! grep -q "pick something you like" "${identityPath}"; then`,
    `  echo "${identityPath}"`,
    '  exit 0',
    'fi',
    `printf '%s' '${encoded}' | base64 -d > "${identityPath}"`,
    `echo "${identityPath}"`,
  ].join('\n');
  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });
  return result.stdout.trim() || identityPath;
};

const readOpenClawHeartbeatFile = async (accountId, { gateway } = {}) => {
  try {
    const podName = await resolveGatewayPodNameWithRetry(gateway);
    const heartbeatPath = `/workspace/${accountId}/HEARTBEAT.md`;
    const result = await execInPod({
      podName,
      containerName: 'clawdbot-gateway',
      command: ['sh', '-lc', `[ -f "${heartbeatPath}" ] && cat "${heartbeatPath}" || echo ""`],
    });
    return result.stdout || '';
  } catch {
    return '';
  }
};

const readOpenClawIdentityFile = async (accountId, { gateway } = {}) => {
  try {
    const podName = await resolveGatewayPodNameWithRetry(gateway);
    const identityPath = `/workspace/${accountId}/IDENTITY.md`;
    const result = await execInPod({
      podName,
      containerName: 'clawdbot-gateway',
      command: ['sh', '-lc', `[ -f "${identityPath}" ] && cat "${identityPath}" || echo ""`],
    });
    return result.stdout || '';
  } catch {
    return '';
  }
};

const ensureWorkspaceSoulFile = async (accountId, content, { gateway } = {}) => {
  if (!content || !String(content).trim()) return null;
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const workspacePath = '/workspace';
  const soulPath = `${workspacePath}/${accountId}/SOUL.md`;
  const normalized = String(content).trim();
  const encoded = Buffer.from(`${normalized}\n`, 'utf8').toString('base64');
  const script = [
    'set -eu',
    `mkdir -p "${workspacePath}/${accountId}"`,
    `printf '%s' '${encoded}' | base64 -d > "${soulPath}"`,
    `echo "${soulPath}"`,
  ].join('\n');
  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });
  return result.stdout.trim() || soulPath;
};

const ensureHeartbeatTemplate = async (accountId, heartbeat, { gateway, customContent, forceOverwrite } = {}) => {
  if (!heartbeat || heartbeat.enabled === false) return null;
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const workspacePath = '/workspace';
  const heartbeatPath = `${workspacePath}/${accountId}/HEARTBEAT.md`;
  // Use preset-specific customContent if provided; otherwise fall back to default template
  const templateContent = (customContent && customContent.trim())
    ? customContent
    : normalizeHeartbeatContent(DEFAULT_HEARTBEAT_CONTENT);
  const encoded = Buffer.from(templateContent.endsWith('\n') ? templateContent : `${templateContent}\n`, 'utf8').toString('base64');
  // When forceOverwrite is true (preset-driven), always write the template.
  // Otherwise, preserve existing non-stale HEARTBEAT.md files.
  const overwriteCondition = forceOverwrite
    ? `printf '%s' '${encoded}' | base64 -d > "${heartbeatPath}"`
    : [
      `if grep -q "via user-token routes" "${heartbeatPath}" || grep -q "with runtime token, or \\\`/api/pods/:podId/context\\\` with user token" "${heartbeatPath}"; then`,
      `    printf '%s' '${encoded}' | base64 -d > "${heartbeatPath}"`,
      '  fi',
    ].join('\n');
  const script = [
    'set -eu',
    `mkdir -p "${workspacePath}/${accountId}"`,
    `if [ -s "${heartbeatPath}" ]; then`,
    `  ${overwriteCondition}`,
    `  echo "${heartbeatPath}"`,
    '  exit 0',
    'fi',
    `printf '%s' '${encoded}' | base64 -d > "${heartbeatPath}"`,
    `echo "${heartbeatPath}"`,
  ].join('\n');
  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });
  return result.stdout.trim() || heartbeatPath;
};

/**
 * Sync a newly provisioned account into /state/moltbot.json on the gateway PVC.
 * The init container (clawdbot-auth-seed) reads /state/moltbot.json, not the
 * ConfigMap, so new accounts must appear there too or the init container will
 * never write their auth-profiles.json and the gateway will skip them on startup.
 */
const syncAccountToStateMoltbot = async (accountId, accountEntry, agentEntry, binding, { gateway } = {}) => {
  let podName;
  try {
    podName = await resolveGatewayPodNameWithRetry(gateway);
  } catch {
    // Gateway may not be running yet (first provision); skip silently.
    return;
  }

  const script = [
    'set -eu',
    'STATE=/state/moltbot.json',
    'if [ ! -f "$STATE" ]; then exit 0; fi',
    `python3 - <<'PYEOF'`,
    'import json, sys',
    'with open("/state/moltbot.json") as f: d = json.load(f)',
    `account_id = ${JSON.stringify(accountId)}`,
    `account_entry = ${JSON.stringify(accountEntry)}`,
    `agent_entry = ${JSON.stringify(agentEntry)}`,
    `binding = ${JSON.stringify(binding)}`,
    // Accounts
    'd.setdefault("channels", {}).setdefault("commonly", {}).setdefault("accounts", {})',
    'accts = d["channels"]["commonly"]["accounts"]',
    'if account_id not in accts: accts[account_id] = account_entry; print("[state-sync] added account:", account_id)',
    'else: print("[state-sync] account already present:", account_id)',
    // Agents list — upsert: add if missing, update model+heartbeat if already present
    'd.setdefault("agents", {}).setdefault("list", [])',
    'ids = [a.get("id") for a in d["agents"]["list"]]',
    'if agent_entry:',
    '    if account_id not in ids:',
    '        d["agents"]["list"].append(agent_entry); print("[state-sync] added agent:", account_id)',
    '    else:',
    '        for a in d["agents"]["list"]:',
    '            if a.get("id") == account_id:',
    '                if "model" in agent_entry: a["model"] = agent_entry["model"]',
    '                elif "model" in a: del a["model"]',
    '                if "heartbeat" in agent_entry: a["heartbeat"] = agent_entry["heartbeat"]',
    '                print("[state-sync] updated agent:", account_id); break',
    // Bindings
    'd.setdefault("bindings", [])',
    'bids = [b.get("match", {}).get("accountId") for b in d["bindings"]]',
    'if binding and account_id not in bids: d["bindings"].append(binding); print("[state-sync] added binding:", account_id)',
    // Required since upstream v2026.2.26: non-loopback gateway requires controlUi origin config
    'd.setdefault("gateway", {}).setdefault("controlUi", {})',
    'if not d["gateway"]["controlUi"].get("allowedOrigins") and not d["gateway"]["controlUi"].get("dangerouslyAllowHostHeaderOriginFallback"): d["gateway"]["controlUi"]["dangerouslyAllowHostHeaderOriginFallback"] = True; print("[state-sync] set dangerouslyAllowHostHeaderOriginFallback")',
    'with open("/state/moltbot.json", "w") as f: json.dump(d, f, indent=2)',
    'PYEOF',
  ].join('\n');

  await execInPod({ podName, containerName: 'clawdbot-gateway', command: ['sh', '-lc', script] });
};

const normalizeWorkspaceDocs = async (accountId, { gateway } = {}) => {
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const workspacePath = '/workspace';
  const agentPath = `${workspacePath}/${accountId}`;
  const agentsPath = `${agentPath}/AGENTS.md`;
  const heartbeatPath = `${agentPath}/HEARTBEAT.md`;
  const toolsPath = `${agentPath}/TOOLS.md`;
  const commonlySkillPath = `${agentPath}/skills/commonly/SKILL.md`;
  const script = [
    'set -eu',
    `if [ -f "${agentsPath}" ]; then`,
    `  sed -i "s|^- When asked what skills are available, run: openclaw skills list --eligible --json$|- When asked what skills are available, inspect ./skills in this workspace and report exact skill folder names.|" "${agentsPath}" || true`,
    `  sed -i "s|^- Report the exact skill names from that output; do not guess from memory\\\\.$|- Report only names that exist as ./skills/{name}/SKILL.md; do not use global/system skill lists.|" "${agentsPath}" || true`,
    `fi`,
    `if [ -f "${heartbeatPath}" ]; then`,
    `  sed -i "s|/home/node/.clawdbot/skills/commonly/SKILL.md|./skills/commonly/SKILL.md|g" "${heartbeatPath}" || true`,
    `  sed -i "s|^- Fetch last .*recent posts.*$|- Fetch last 8 chat messages and 4 recent posts using runtime-token routes: \\\`/api/agents/runtime/pods/:podId/messages?limit=8\\\` and \\\`/api/posts?podId=:podId\\&limit=4\\\`.|g" "${heartbeatPath}" || true`,
    `  sed -i "s|Fetch last 20 chat messages and 10 recent posts|Fetch last 8 chat messages and 4 recent posts|g" "${heartbeatPath}" || true`,
    `  sed -i "s|/api/agents/runtime/pods/:podId/messages?limit=20|/api/agents/runtime/pods/:podId/messages?limit=8|g" "${heartbeatPath}" || true`,
    `  sed -i "s|/api/posts?podId=:podId\\&limit=10|/api/posts?podId=:podId\\&limit=4|g" "${heartbeatPath}" || true`,
    `  sed -i "s|via user-token routes: \`/api/messages/:podId?limit=20\` and \`/api/posts?podId=:podId\\&limit=10\`.|using runtime-token routes: \`/api/agents/runtime/pods/:podId/messages?limit=8\` and \`/api/posts?podId=:podId\\&limit=4\`.|g" "${heartbeatPath}" || true`,
    `  sed -i "s|If \\\`commonly\\\` skill is missing, use HTTP APIs directly (do not run \\\`commonly --help\\\`): context via \\\`/api/agents/runtime/pods/:podId/context\\\` with runtime token, or \\\`/api/pods/:podId/context\\\` with user token.|If \\\`commonly\\\` skill is missing, use HTTP APIs directly (do not run \\\`commonly --help\\\`) with runtime token: context via \\\`/api/agents/runtime/pods/:podId/context\\\`.|g" "${heartbeatPath}" || true`,
    `  if ! grep -q "Resolve \\\`podId\\\` from the incoming event context" "${heartbeatPath}"; then`,
    `    sed -i "/read and follow \\\`\\.\\/skills\\/commonly\\/SKILL.md\\\` in this agent workspace\\./a - Resolve \\\`podId\\\` from the incoming runtime event payload. Do not use placeholder pod ids or Commonly target syntax." "${heartbeatPath}" || true`,
    '  fi',
    `  if ! grep -q "If there is no pod/channel context for this run" "${heartbeatPath}"; then`,
    `    sed -i "/Resolve \\\`podId\\\` from the incoming event context/a - If there is no pod\\/channel context for this run, do not guess a pod id. Post a short mention-only fallback in your most recent active pod." "${heartbeatPath}" || true`,
    '  fi',
    `  if ! grep -q "Do not run token-diagnostic shell checks" "${heartbeatPath}"; then`,
    `    sed -i "/Prefer runtime-token HTTP reads first for heartbeat checks/a - Do not run token-diagnostic shell checks (\\\`env\\\`, \\\`curl\\\` auth probes) as heartbeat output." "${heartbeatPath}" || true`,
    '  fi',
    `  if ! grep -q "Never narrate your checking process in pod chat" "${heartbeatPath}"; then`,
    `    sed -i "/Never post token\\/config complaints/a - Never narrate your checking process in pod chat (examples: \\"I will check...\\", \\"let me try...\\", \\"I need to check...\\")." "${heartbeatPath}" || true`,
    '  fi',
    `  if ! grep -q "Never call runtime APIs via localhost" "${heartbeatPath}"; then`,
    `    sed -i "/Never post token\\/config complaints/a - Never call runtime APIs via localhost (for example \\\`http:\\/\\/localhost:3000\\\`). Use \\\`\\$\\{COMMONLY_API_URL:-http:\\/\\/backend.commonly.svc.cluster.local:5000\\}\\\` when absolute URLs are needed." "${heartbeatPath}" || true`,
    '  fi',
    `  if ! grep -q "Never ask users/owners/other agents which tool or parameter to use during heartbeat" "${heartbeatPath}"; then`,
    `    sed -i "/Never narrate your checking process in pod chat/a - Never ask users\\/owners\\/other agents which tool or parameter to use during heartbeat." "${heartbeatPath}" || true`,
    '  fi',
    `  sed -i "s|http://localhost:3000|\\\${COMMONLY_API_URL:-http://backend.commonly.svc.cluster.local:5000}|g" "${heartbeatPath}" || true`,
    `  if ! grep -q "Do not repeat or paraphrase your own previous heartbeat message" "${heartbeatPath}"; then`,
    `    sed -i "/Do not post housekeeping-only status updates/a - Do not repeat or paraphrase your own previous heartbeat message. If activity is unchanged, still post a fresh short mention update with a different phrasing." "${heartbeatPath}" || true`,
    '  fi',
    `  sed -i "s|Fetch last 20 chat messages and 10 recent posts using runtime-token routes: \\\`/api/agents/runtime/pods/:podId/messages?limit=20\\\` and \\\`/api/posts?podId=:podId\\&limit=10\\\`.|Fetch last 8 chat messages and 4 recent posts using runtime-token routes: \\\`/api/agents/runtime/pods/:podId/messages?limit=8\\\` and \\\`/api/posts?podId=:podId\\&limit=4\\\`.|g" "${heartbeatPath}" || true`,
    `  if ! grep -q "Heartbeat check is incomplete unless you actually read pod activity each run" "${heartbeatPath}"; then`,
    `    sed -i "/Fetch last 8 chat messages and 4 recent posts/a - Heartbeat check is incomplete unless you actually read pod activity each run (tools or runtime HTTP fallback)." "${heartbeatPath}" || true`,
    '  fi',
    `  if ! grep -q "On every heartbeat run, always post one concise conversational update" "${heartbeatPath}"; then`,
    `    sed -i "/If there is something new, post a conversational, high-signal update to the pod chat and reply to relevant posts\\/threads\\./i - On every heartbeat run, always post one concise conversational update to pod chat.\\n- Every heartbeat update must include at least one direct agent mention using instance ids (example: \\\`@tom\\\`, \\\`@liz\\\`, \\\`@x-curator\\\`)." "${heartbeatPath}" || true`,
    '  fi',
    `  sed -i "s|If no meaningful new signal exists, reply HEARTBEAT_OK.|If no meaningful new signal exists, still post a short conversational mention update.|g" "${heartbeatPath}" || true`,
    `  sed -i "s|- If nothing new, reply HEARTBEAT_OK\\.|- Never output control tokens like HEARTBEAT_OK\\/HEARTBEAT_NOOP in pod chat.|g" "${heartbeatPath}" || true`,
    `  if ! grep -q "verify or enrich it with \\\`web_search\\\` when available" "${heartbeatPath}"; then`,
    `    sed -i "/Heartbeat check is incomplete unless you actually read pod activity each run/a - If you detect a materially new topic, verify or enrich it with \\\`web_search\\\` when available before posting. Keep sources concise and relevant." "${heartbeatPath}" || true`,
    '  fi',
    `  if ! grep -q "describe them as connected feed or integration-ingested posts" "${heartbeatPath}"; then`,
    `    sed -i "/If there are new non-bot chat messages since your last heartbeat and you have not replied yet, send one concise conversational reply\\./a - When discussing X\\/Instagram items, describe them as connected feed or integration-ingested posts. Do not imply they were authored directly in the pod." "${heartbeatPath}" || true`,
    '  fi',
    'fi',
    // Ensure TOOLS.md has the acpx_run routing instruction (idempotent)
    `if [ -f "${toolsPath}" ]; then`,
    `  if ! grep -q "acpx_run" "${toolsPath}"; then`,
    `    cat >> "${toolsPath}" <<'EOF'`,
    '',
    '## Coding agent tasks (acpx_run)',
    '',
    'To run codex, claude, pi, gemini, opencode, or kimi:',
    '- Call `acpx_run` — synchronous, blocks until done, returns full output in the same message.',
    '- Do NOT use `sessions_spawn` — it is async and the result never comes back to this channel.',
    '- Wrap all code output in markdown fences: ```language ... ``` for proper rendering.',
    '',
    'EOF',
    '  fi',
    // Inject/update the default branch note — sed replaces if present, appends if not
    `  if grep -q "## Git workflow" "${toolsPath}"; then`,
    `    sed -i "s|Default PR target branch: \`[^${'`'}]*\`|Default PR target branch: \`${DEFAULT_BRANCH}\`|g" "${toolsPath}" || true`,
    `  else`,
    `    printf '\\n## Git workflow\\n\\n- Default PR target branch: \`${DEFAULT_BRANCH}\`\\n- All PRs must target this branch. Update when the release branch changes.\\n' >> "${toolsPath}"`,
    `  fi`,
    `fi`,
    `if [ -f "${commonlySkillPath}" ]; then`,
    `  sed -i "s|## Recent Messages (user token)|## Recent Messages (runtime token)|g" "${commonlySkillPath}" || true`,
    '  sed -i "s|/api/messages/${POD_ID}?limit=${LIMIT:-20}|/api/agents/runtime/pods/${POD_ID}/messages?limit=${LIMIT:-20}|g" "' + commonlySkillPath + '" || true',
    '  sed -i "s|${OPENCLAW_USER_TOKEN:-$COMMONLY_USER_TOKEN}|${OPENCLAW_RUNTIME_TOKEN:-$COMMONLY_API_TOKEN}|g" "' + commonlySkillPath + '" || true',
    '  sed -i "s|ACCOUNT_ID=\"${ACCOUNT_ID:-$(basename \\\"$PWD\\\")}\"|ACCOUNT_ID=\"${ACCOUNT_ID:-${OPENCLAW_AGENT_ID:-$(basename \\\"$PWD\\\")}}\"|g" "' + commonlySkillPath + '" || true',
    `  if grep -q "ACCOUNT_ID=\\"\\\${ACCOUNT_ID:-\\\${OPENCLAW_AGENT_ID:-\\\$(basename \\\\\\"\\\$PWD\\\\\\")\\\}}\\"" "${commonlySkillPath}" && ! grep -q "^export ACCOUNT_ID$" "${commonlySkillPath}"; then`,
    `    sed -i "/ACCOUNT_ID=\\"\\\${ACCOUNT_ID:-\\\${OPENCLAW_AGENT_ID:-\\\$(basename \\\\\\"\\\$PWD\\\\\\")\\\}}\\"/a export ACCOUNT_ID" "${commonlySkillPath}" || true`,
    '  fi',
    `  if grep -q "User token: \\\`OPENCLAW_USER_TOKEN\\\` or \\\`COMMONLY_USER_TOKEN\\\`" "${commonlySkillPath}"; then`,
    `    sed -i "s|- Runtime token: \\\`OPENCLAW_RUNTIME_TOKEN\\\` or \\\`COMMONLY_API_TOKEN\\\` (\\\`cm_agent_...\\\`)|- Runtime token: \\\`OPENCLAW_RUNTIME_TOKEN\\\` or \\\`COMMONLY_API_TOKEN\\\` (\\\`cm_agent_...\\\`)\\n- \\\`POD_ID\\\` from the current heartbeat\\/mention event payload (\\\`podId\\\` field).|g" "${commonlySkillPath}" || true`,
    `    sed -i "/User token: \\\`OPENCLAW_USER_TOKEN\\\` or \\\`COMMONLY_USER_TOKEN\\\` (\\\`cm_...\\\`)/d" "${commonlySkillPath}" || true`,
    '  fi',
    `  if ! grep -q "commonly_read_context" "${commonlySkillPath}"; then`,
    `    cat >> "${commonlySkillPath}" <<'EOF'`,
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
    'Use `podId` from runtime event payload (`podId` field). Do not use Commonly target syntax.',
    '',
    'EOF',
    '  fi',
    `  if ! grep -q "Resolve per-agent tokens from gateway config" "${commonlySkillPath}"; then`,
    `    cat >> "${commonlySkillPath}" <<'EOF'`,
    '',
    '## Optional HTTP fallback (only if tools are unavailable)',
    '',
    '```bash',
    '# Resolve per-agent tokens from gateway config using current workspace account id.',
    'ACCOUNT_ID="${ACCOUNT_ID:-${OPENCLAW_AGENT_ID:-$(basename "$PWD")}}"',
    'export ACCOUNT_ID',
    'COMMONLY_API_TOKEN="${COMMONLY_API_TOKEN:-$(node -e \'const fs=require("fs");const c=JSON.parse(fs.readFileSync("/config/moltbot.json","utf8"));const id=process.env.ACCOUNT_ID||"";process.stdout.write((c?.channels?.commonly?.accounts?.[id]?.runtimeToken)||"");\')}"',
    'COMMONLY_USER_TOKEN="${COMMONLY_USER_TOKEN:-$(node -e \'const fs=require("fs");const c=JSON.parse(fs.readFileSync("/config/moltbot.json","utf8"));const id=process.env.ACCOUNT_ID||"";process.stdout.write((c?.channels?.commonly?.accounts?.[id]?.userToken)||"");\')}"',
    '```',
    '',
    'EOF',
    '  fi',
    `  if ! grep -q "Create a Pod (user token)" "${commonlySkillPath}"; then`,
    `    cat >> "${commonlySkillPath}" <<'EOF'`,
    '',
    '## Create a Pod (user token)',
    '',
    '```bash',
    'curl -s -X POST "${COMMONLY_API_URL:-http://backend:5000}/api/pods" \\',
    '  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d "{\\"name\\": \\"${POD_NAME}\\", \\"description\\": \\"${POD_DESCRIPTION:-}\\"}"',
    '```',
    '',
    '## Join a Pod (user token)',
    '',
    '```bash',
    'curl -s -X POST "${COMMONLY_API_URL:-http://backend:5000}/api/pods/${POD_ID}/join" \\',
    '  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}"',
    '```',
    '',
    '## Create a Feed Post (user token)',
    '',
    '```bash',
    'curl -s -X POST "${COMMONLY_API_URL:-http://backend:5000}/api/posts" \\',
    '  -H "Authorization: Bearer ${COMMONLY_USER_TOKEN}" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d "{\\"content\\": \\"${POST_CONTENT}\\", \\"podId\\": \\"${POD_ID:-}\\"}"',
    '```',
    '',
    'EOF',
    '  fi',
    'fi',
    `echo "${agentPath}"`,
  ].join('\n');

  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });
  return result.stdout.trim() || agentPath;
};

const ensureWorkspaceMemoryFiles = async (accountId, { gateway } = {}) => {
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const workspacePath = '/workspace';
  const agentPath = `${workspacePath}/${accountId}`;
  const memoryDir = `${agentPath}/memory`;
  const longTermMemoryPath = `${agentPath}/MEMORY.md`;
  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = `${memoryDir}/${today}.md`;
  const memoryTemplate = [
    '# MEMORY.md',
    '',
    'Long-term memory for this agent.',
    '- Keep durable preferences, decisions, and recurring context here.',
    '- Do not store secrets unless explicitly required.',
    '',
  ].join('\n');
  const encodedMemory = Buffer.from(memoryTemplate, 'utf8').toString('base64');
  const script = [
    'set -eu',
    `mkdir -p "${memoryDir}"`,
    `if [ ! -f "${longTermMemoryPath}" ]; then`,
    `  printf '%s' '${encodedMemory}' | base64 -d > "${longTermMemoryPath}"`,
    'fi',
    `if [ ! -f "${dailyPath}" ]; then`,
    `  printf '# ${today}\\n\\n' > "${dailyPath}"`,
    'fi',
    `echo "${agentPath}"`,
  ].join('\n');
  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });
  return result.stdout.trim() || agentPath;
};

const listOpenClawPlugins = async ({ gateway } = {}) => {
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['node', 'dist/index.js', 'plugins', 'list', '--json'],
  });
  let payload;
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new Error('Failed to parse OpenClaw plugin list output.');
  }
  return {
    ...payload,
    pod: podName,
    deployment: resolveGatewayDeploymentName(gateway),
  };
};

const installOpenClawPlugin = async ({ spec, link = false, gateway } = {}) => {
  if (!spec || typeof spec !== 'string') {
    throw new Error('spec is required');
  }
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const command = ['node', 'dist/index.js', 'plugins', 'install', spec];
  if (link) {
    command.push('--link');
  }
  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: command.join(' '),
    pod: podName,
    deployment: resolveGatewayDeploymentName(gateway),
  };
};

const listOpenClawBundledSkills = async ({ gateway } = {}) => {
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: [
      'sh',
      '-lc',
      `if [ -d "${OPENCLAW_BUNDLED_SKILLS_DIR}" ]; then for d in "${OPENCLAW_BUNDLED_SKILLS_DIR}"/*; do [ -d "$d" ] && basename "$d"; done | sort; fi`,
    ],
  });
  const skills = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
  return {
    skills,
    pod: podName,
    deployment: resolveGatewayDeploymentName(gateway),
  };
};

const syncOpenClawSkills = async ({
  accountId,
  podIds = [],
  mode = 'all',
  skillNames = [],
  gateway,
  defaultCommonlySkillContent = '',
  bundledSkills = [],
} = {}) => {
  if (!accountId) {
    throw new Error('accountId is required');
  }

  const files = [];
  const seedCommonlySkill = String(defaultCommonlySkillContent || '').trim();
  if (seedCommonlySkill) {
    files.push({
      path: 'commonly/SKILL.md',
      content: seedCommonlySkill.endsWith('\n') ? seedCommonlySkill : `${seedCommonlySkill}\n`,
      mode: '0644',
    });
  }

  // Seed any bundled extension skills (e.g. acp-router from acpx extension)
  if (Array.isArray(bundledSkills)) {
    bundledSkills.forEach(({ name, content: skillContent }) => {
      const trimmed = String(skillContent || '').trim();
      if (!name || !trimmed) return;
      files.push({
        path: `${name}/SKILL.md`,
        content: trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`,
        mode: '0644',
      });
    });
  }

  const normalizedPods = Array.isArray(podIds)
    ? podIds.map((id) => String(id)).filter(Boolean)
    : [];
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

    const assets = await PodAsset.find(query).lean();
    assets.forEach((asset) => {
      const skillName = asset?.metadata?.skillName || asset?.title?.replace(/^Skill:\s*/i, '') || '';
      if (!skillName) return;
      const slug = PodAssetService.normalizeSkillKey(skillName);
      const baseSkillPath = `${slug}/SKILL.md`;
      const content = String(asset?.content || '');
      files.push({
        path: baseSkillPath,
        content: content.endsWith('\n') ? content : `${content}\n`,
        mode: '0644',
      });

      const extraFiles = Array.isArray(asset?.metadata?.extraFiles)
        ? asset.metadata.extraFiles
        : [];
      extraFiles.forEach((file) => {
        const relPathRaw = String(file?.path || '').trim().replace(/\\/g, '/');
        const fileContent = file?.content;
        if (!relPathRaw || typeof fileContent !== 'string') return;
        const relPath = relPathRaw.replace(/^\/+/, '');
        const segments = relPath.split('/').filter(Boolean);
        if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) return;
        const lower = relPath.toLowerCase();
        const isScript = lower.includes('/scripts/')
          || lower.endsWith('.py')
          || lower.endsWith('.sh')
          || lower.endsWith('.bash');
        files.push({
          path: `${slug}/${segments.join('/')}`,
          content: fileContent,
          mode: isScript ? '0755' : '0644',
        });
      });
    });
  }

  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const manifest = Buffer.from(JSON.stringify(files), 'utf8').toString('base64');
  const workspacePath = '/workspace';
  const skillsDir = `${workspacePath}/${accountId}/skills`;
  const manifestPath = `/tmp/commonly-skills-${accountId}.json`;
  const script = [
    'set -eu',
    `rm -rf "${skillsDir}"`,
    `mkdir -p "${skillsDir}"`,
    `printf '%s' '${manifest}' | base64 -d > "${manifestPath}"`,
    `node - "${manifestPath}" <<'NODE'`,
    'const fs = require("fs");',
    'const path = require("path");',
    `const rootDir = ${JSON.stringify(skillsDir)};`,
    'const manifestPath = process.argv[2];',
    'const entries = JSON.parse(fs.readFileSync(manifestPath, "utf8"));',
    'for (const entry of entries) {',
    '  const relPath = String(entry.path || "").replace(/^\\/+/, "");',
    '  if (!relPath) continue;',
    '  const target = path.normalize(path.join(rootDir, relPath));',
    '  if (!target.startsWith(path.normalize(rootDir + path.sep))) continue;',
    '  fs.mkdirSync(path.dirname(target), { recursive: true });',
    '  fs.writeFileSync(target, String(entry.content || ""));',
    '  if (entry.mode) {',
    '    fs.chmodSync(target, parseInt(String(entry.mode), 8));',
    '  }',
    '}',
    'NODE',
    `rm -f "${manifestPath}"`,
    // Copy skills from enabled extension skill dirs (e.g. /app/extensions/acpx/skills/acp-router)
    // Only copies if the extension dir exists AND the skill is not already written by the manifest.
    'for ext_skill_dir in /app/extensions/acpx/skills/*/; do',
    '  skill_name=$(basename "$ext_skill_dir")',
    `  skill_target="${skillsDir}/$skill_name/SKILL.md"`,
    '  if [ -f "${ext_skill_dir}SKILL.md" ] && [ ! -f "$skill_target" ]; then',
    '    mkdir -p "$(dirname "$skill_target")"',
    '    cp "${ext_skill_dir}SKILL.md" "$skill_target"',
    '  fi',
    'done',
    `echo "${skillsDir}"`,
  ].join('\n');

  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });
  return result.stdout.trim() || skillsDir;
};

/**
 * Read ConfigMap data
 */
const readConfigMap = async (configMapName, key) => {
  try {
    const response = await k8sApi.readNamespacedConfigMap(configMapName, NAMESPACE);
    const data = response.body.data || {};
    const raw = data[key] || '{}';
    return JSON.parse(raw);
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      console.log(`[k8s-provisioner] ConfigMap ${configMapName} not found, will create`);
      return {};
    }
    throw new Error(`Failed to read ConfigMap ${configMapName}: ${error.message}`);
  }
};

/**
 * Write ConfigMap data
 */
const writeConfigMap = async (configMapName, key, data) => {
  const dataString = JSON.stringify(data, null, 2);
  const configMap = {
    metadata: {
      name: configMapName,
      namespace: NAMESPACE,
      labels: {
        'app.kubernetes.io/managed-by': 'commonly-backend',
        'app.kubernetes.io/component': 'agent-config',
      },
    },
    data: {
      [key]: dataString,
    },
  };

  try {
    // Try to update existing ConfigMap (requires resourceVersion)
    const existing = await k8sApi.readNamespacedConfigMap(configMapName, NAMESPACE);
    if (existing?.body?.metadata?.resourceVersion) {
      configMap.metadata.resourceVersion = existing.body.metadata.resourceVersion;
    }
    await k8sApi.replaceNamespacedConfigMap(configMapName, NAMESPACE, configMap);
    console.log(`[k8s-provisioner] Updated ConfigMap ${configMapName}`);
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      // Create new ConfigMap
      await k8sApi.createNamespacedConfigMap(NAMESPACE, configMap);
      console.log(`[k8s-provisioner] Created ConfigMap ${configMapName}`);
    } else {
      throw new Error(`Failed to write ConfigMap ${configMapName}: ${error.message}`);
    }
  }
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

const applySkillEnvEntriesToConfig = (config, skillEnv = {}) => {
  if (!skillEnv || typeof skillEnv !== 'object') return;
  config.skills = config.skills || {};
  config.skills.entries = config.skills.entries || {};

  Object.entries(skillEnv).forEach(([skillName, entry]) => {
    const skillKey = PodAssetService.normalizeSkillKey(skillName);
    if (!skillKey) return;
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
};

const extractGatewaySkillEntries = (config) => {
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
  const configMapName = resolveGatewayConfigMapName(gateway);
  const config = await readConfigMap(configMapName, 'moltbot.json');
  return extractGatewaySkillEntries(config);
};

const syncGatewaySkillEnv = async ({ gateway, entries } = {}) => {
  const configMapName = resolveGatewayConfigMapName(gateway);
  const config = await readConfigMap(configMapName, 'moltbot.json');
  applySkillEnvEntriesToConfig(config, entries);
  await writeConfigMap(configMapName, 'moltbot.json', config);
  return extractGatewaySkillEntries(config);
};

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
  const braveApiKey2 = String(process.env.BRAVE_API_KEY_2 || '').trim();
  const firecrawlApiKey = String(process.env.FIRECRAWL_API_KEY || '').trim();
  // Use key 2 as fallback if key 1 is absent
  const activeBraveKey = braveApiKey || braveApiKey2;
  if (!activeBraveKey && !firecrawlApiKey) return;
  config.tools = config.tools || {};
  config.tools.web = config.tools.web || {};
  if (activeBraveKey) {
    config.tools.web.search = config.tools.web.search || {};
    if (!config.tools.web.search.provider) {
      config.tools.web.search.provider = 'brave';
    }
    if (!config.tools.web.search.apiKey) {
      config.tools.web.search.apiKey = activeBraveKey;
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

const applyOpenClawMemoryDefaults = (config) => {
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.memorySearch = config.agents.defaults.memorySearch || {};
  if (config.agents.defaults.memorySearch.enabled === undefined) {
    config.agents.defaults.memorySearch.enabled = true;
  }
  if (!Array.isArray(config.agents.defaults.memorySearch.sources)) {
    config.agents.defaults.memorySearch.sources = ['memory'];
  }
};

const applyOpenClawContextDefaults = (config) => {
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.contextPruning = config.agents.defaults.contextPruning || {};
  if (!config.agents.defaults.contextPruning.mode) {
    config.agents.defaults.contextPruning.mode = 'cache-ttl';
  }
  if (!config.agents.defaults.contextPruning.ttl) {
    config.agents.defaults.contextPruning.ttl = '90m';
  }
  if (typeof config.agents.defaults.contextPruning.keepLastAssistants !== 'number') {
    config.agents.defaults.contextPruning.keepLastAssistants = 2;
  }
};

// Direct Gemini provider fallbacks (google/ prefix, not via OpenRouter).
// Requires a valid GEMINI_API_KEY in the gateway's api-keys secret.
const GEMINI_FALLBACKS = [
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.0-flash',
];

// Default dev agent IDs — overridden by DB openclaw.devAgentIds if set.
const DEFAULT_DEV_AGENT_IDS = ['theo', 'nova', 'pixel', 'ops'];

const applyOpenClawAcpxPluginDefaults = (config) => {
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  if (!config.plugins.entries.acpx) {
    config.plugins.entries.acpx = {
      enabled: true,
      config: {
        permissionMode: 'approve-all',
      },
    };
  } else if (config.plugins.entries.acpx.enabled === undefined) {
    config.plugins.entries.acpx.enabled = true;
  }
};

/**
 * Issue (or re-issue) a LiteLLM virtual key for the given agent.
 * Returns the key string (sk-...) on success, null if LiteLLM is not configured.
 * Keys are not deduplicated — re-provisioning creates a new key each time.
 * Old keys remain valid in LiteLLM DB (harmless orphans).
 */
const issueLiteLLMVirtualKey = async (agentId) => {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const masterKey = (process.env.LITELLM_MASTER_KEY || '').trim();
  if (!baseUrl || !masterKey) return null;
  try {
    const axios = require('axios');
    const headers = { Authorization: `Bearer ${masterKey}` };

    // Read current key from PVC. If it is still valid in LiteLLM, reuse it — this makes
    // the function idempotent so concurrent provisioning calls don't race-delete each other.
    let existingKey = null;
    try {
      const gwPod = await waitForReadyGatewayPod(10000, 2000);
      if (gwPod) {
        const readScript = `node -e "try{const s=JSON.parse(require('fs').readFileSync('/state/agents/${agentId}/agent/auth-profiles.json','utf8'));const p=s.profiles&&s.profiles['openai-codex:codex-cli'];process.stdout.write(p&&p.access?p.access:'');} catch(e){}"`;
        const out = await new Promise((resolve) => {
          const chunks = [];
          const s = new stream.PassThrough();
          s.on('data', (d) => chunks.push(d));
          k8sExec.exec(NAMESPACE, gwPod.metadata.name, 'clawdbot-gateway',
            ['sh', '-c', readScript], s, null, null, false,
            () => resolve(Buffer.concat(chunks).toString().trim()),
          ).catch(() => resolve(''));
        });
        if (out && out.startsWith('sk-')) existingKey = out;
      }
    } catch (_) { /* best-effort */ }

    // Check if existing key is still valid in LiteLLM DB AND belongs to this agent.
    // Without the ownership check, a key mistakenly written to the wrong agent's PVC
    // would be perpetually reused across reprovisions.
    if (existingKey) {
      try {
        const check = await axios.get(`${baseUrl}/key/info?key=${existingKey}`, { headers });
        const info = check.data?.info;
        if (info && (info.metadata?.agent_id === agentId || info.user_id === agentId)) {
          return existingKey; // still valid and owned by this agent
        }
        // Key exists in DB but is invalid or belongs to another agent — delete it so it
        // doesn't accumulate as an orphan, then fall through to issue a fresh one.
        if (info) {
          await axios.delete(`${baseUrl}/key/delete`, { headers, data: { keys: [existingKey] } }).catch(() => {});
          console.log(`[litellm] Deleted stale/misowned key for ${agentId}`);
        }
      } catch (_) { /* key not in DB — fall through to issue a new one */ }
    }

    const resp = await axios.post(
      `${baseUrl}/key/generate`,
      {
        user_id: agentId,
        // Grant access to all models the agent may use.
        // OpenClaw strips "openrouter/" prefix when using openrouter:default profile,
        // so we allow both prefixed and un-prefixed variants.
        models: [
          'gpt-5.4',
          'openai-codex/gpt-5.4',
          'gpt-5.4-mini',
          'openai-codex/gpt-5.4-mini',
          'google/gemini-2.5-flash',
          'google/gemini-2.5-flash-lite',
          'google/gemini-2.0-flash',
          'gemini-2.5-flash',
          'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
          'nvidia/nemotron-3-super-120b-a12b:free',
          'openrouter/arcee-ai/trinity-large-preview:free',
          'arcee-ai/trinity-large-preview:free',
        ],
        metadata: { agent_id: agentId, provisioned_at: new Date().toISOString() },
      },
      { headers },
    );
    const newKey = resp.data?.key || null;
    if (newKey) console.log(`[litellm] Issued new virtual key for ${agentId}`);
    return newKey;
  } catch (err) {
    console.warn(`[litellm] Virtual key generation failed for ${agentId}: ${err.message}`);
    return null;
  }
};

/**
 * Issue a LiteLLM virtual key scoped to community models (nano + OpenRouter fallbacks).
 * Community agents use gpt-5.4-nano as primary (same Codex OAuth, lowest quota cost)
 * with nemotron/trinity as fallbacks — without granting access to full gpt-5.4/mini (dev-only).
 */
const issueLiteLLMOpenRouterKey = async (agentId) => {
  const baseUrl = process.env.LITELLM_BASE_URL;
  const masterKey = (process.env.LITELLM_MASTER_KEY || '').trim();
  if (!baseUrl || !masterKey) return null;
  try {
    const axios = require('axios');
    const headers = { Authorization: `Bearer ${masterKey}` };

    // Read existing key from openai-codex:codex-cli.access on the agent PVC.
    // We read from codex-cli.access (not openrouter:default.key) because openrouter:default
    // may hold the real OpenRouter API key (sk-or-v1-...) which is not a LiteLLM virtual key.
    let existingKey = null;
    try {
      const gwPod = await waitForReadyGatewayPod(10000, 2000);
      if (gwPod) {
        const readScript = `node -e "try{const s=JSON.parse(require('fs').readFileSync('/state/agents/${agentId}/agent/auth-profiles.json','utf8'));const p=s.profiles&&s.profiles['openai-codex:codex-cli'];process.stdout.write(p&&p.access?p.access:'');} catch(e){}"`;
        const out = await new Promise((resolve) => {
          const chunks = [];
          const s = new stream.PassThrough();
          s.on('data', (d) => chunks.push(d));
          k8sExec.exec(NAMESPACE, gwPod.metadata.name, 'clawdbot-gateway',
            ['sh', '-c', readScript], s, null, null, false,
            () => resolve(Buffer.concat(chunks).toString().trim()),
          ).catch(() => resolve(''));
        });
        if (out && out.startsWith('sk-')) existingKey = out;
      }
    } catch (_) { /* best-effort */ }

    if (existingKey && existingKey !== masterKey) {
      // Safety: never delete the master key even if found on PVC
      try {
        const check = await axios.get(`${baseUrl}/key/info?key=${existingKey}`, { headers });
        const info = check.data?.info;
        if (info && (info.metadata?.agent_id === agentId || info.user_id === agentId)) {
          return existingKey;
        }
        if (info) {
          await axios.delete(`${baseUrl}/key/delete`, { headers, data: { keys: [existingKey] } }).catch(() => {});
          console.log(`[litellm] Deleted stale/misowned OpenRouter key for ${agentId}`);
        }
      } catch (_) { /* key not in DB — fall through */ }
    }

    const resp = await axios.post(
      `${baseUrl}/key/generate`,
      {
        user_id: agentId,
        models: [
          'gpt-5.4-nano',
          'openai-codex/gpt-5.4-nano',
          'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
          'nvidia/nemotron-3-super-120b-a12b:free',
          'openrouter/arcee-ai/trinity-large-preview:free',
          'arcee-ai/trinity-large-preview:free',
          'google/gemini-2.5-flash',
          'google/gemini-2.5-flash-lite',
          'google/gemini-2.0-flash',
          'gemini-2.5-flash',
        ],
        metadata: { agent_id: agentId, key_type: 'openrouter', provisioned_at: new Date().toISOString() },
      },
      { headers },
    );
    const newKey = resp.data?.key || null;
    if (newKey) console.log(`[litellm] Issued OpenRouter virtual key for ${agentId}`);
    return newKey;
  } catch (err) {
    console.warn(`[litellm] OpenRouter virtual key generation failed for ${agentId}: ${err.message}`);
    return null;
  }
};

/**
 * Inject LiteLLM virtual key and real OpenRouter key into the agent PVC auth-profiles.
 * - openai-codex:codex-cli.access = LiteLLM sk-xxx key (read by acpx_run / readAgentLiteLLMKey)
 * - openrouter:default.key = real OpenRouter API key (sk-or-v1-...) so gateway heartbeat
 *   fallbacks that route directly to OpenRouter work correctly
 * The init container runs in patch mode and does NOT update these profiles, so injections
 * persist across gateway restarts.
 */
const injectOpenRouterKeyToAgentAuthProfiles = async (deploymentName, agentId, virtualKey) => {
  if (!virtualKey) return;
  const escaped = virtualKey.replace(/'/g, "\\'");
  // OpenRouter calls are proxied through LiteLLM (openrouter.baseUrl = http://litellm:4000/v1).
  // LiteLLM expects a virtual key for authorization — always use the LiteLLM key for openrouter:default.
  // LiteLLM uses its own litellm_params.api_key (the real OR key) when forwarding to OpenRouter.
  const orDefaultKey = escaped;
  const script = [
    `const fs = require('fs');`,
    `const p = '/state/agents/${agentId}/agent/auth-profiles.json';`,
    `try {`,
    `  const store = JSON.parse(fs.readFileSync(p, 'utf8'));`,
    `  store.profiles['openrouter:default'] = Object.assign({}, store.profiles['openrouter:default'] || {}, { key: '${orDefaultKey}', apiKey: '${orDefaultKey}' });`,
    `  store.profiles['openai-codex:codex-cli'] = Object.assign({}, store.profiles['openai-codex:codex-cli'] || {}, { access: '${escaped}' });`,
    `  store.order = store.order || {};`,
    `  store.order['openai-codex'] = ['openai-codex:codex-cli'];`,
    `  fs.writeFileSync(p, JSON.stringify(store, null, 2));`,
    `  process.stdout.write('ok');`,
    `} catch(e) { process.stdout.write('skip:' + e.message); }`,
  ].join(' ');

  const execOnPod = async (podName) => new Promise((resolve, reject) => {
    const stdoutStream = new stream.PassThrough();
    k8sExec.exec(
      NAMESPACE,
      podName,
      'clawdbot-gateway',
      ['node', '-e', script],
      stdoutStream,
      stdoutStream,
      null,
      false,
      (status) => {
        if (status.status === 'Success') resolve();
        else reject(new Error(status.message || 'exec failed'));
      },
    ).catch(reject);
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const gwPod = await waitForReadyGatewayPod(90000, 5000);
      if (!gwPod) {
        console.warn(`[k8s-provisioner] openrouter key inject skipped for ${agentId}: no ready gateway pod`);
        return;
      }
      await execOnPod(gwPod.metadata.name);
      console.log(`[k8s-provisioner] openrouter key injected for ${agentId}`);
      return;
    } catch (err) {
      if (attempt < 2) {
        console.warn(`[k8s-provisioner] openrouter key inject attempt ${attempt} failed for ${agentId}: ${err.message} — retrying`);
        await new Promise((r) => setTimeout(r, 10000));
      } else {
        console.warn(`[k8s-provisioner] openrouter key inject skipped for ${agentId}: ${err.message}`);
      }
    }
  }
};

const applyOpenClawCodexProviderConfig = async (config) => {
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};

  const litellmBase = process.env.LITELLM_BASE_URL;
  if (litellmBase) {
    // Route Codex through LiteLLM: OpenClaw uses openai-completions format, LiteLLM routes
    // to chatgpt/gpt-5.4 using OAuth tokens seeded by the codex-auth-seed init container.
    // The daily refresh job (refreshCodexOAuthTokenIfNeeded) keeps the token fresh and
    // triggers a LiteLLM pod restart so the init container re-reads the updated secret.
    if (!config.models.providers['openai-codex']) {
      config.models.providers['openai-codex'] = {
        baseUrl: litellmBase,
        api: 'openai-completions',
        models: [
          { id: 'gpt-5.4', name: 'gpt-5.4' },
          { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' },
        ],
      };
    } else {
      config.models.providers['openai-codex'].baseUrl = litellmBase;
      config.models.providers['openai-codex'].api = 'openai-completions';
    }
  } else {
    // Direct Codex API (no LiteLLM)
    const codexBaseUrl = 'https://chatgpt.com/backend-api';
    if (!config.models.providers['openai-codex']) {
      config.models.providers['openai-codex'] = {
        baseUrl: codexBaseUrl,
        api: 'openai-codex-responses',
        models: [{ id: 'gpt-5.3-codex', name: 'gpt-5.3-codex' }],
      };
    } else {
      config.models.providers['openai-codex'].baseUrl = codexBaseUrl;
      config.models.providers['openai-codex'].api = 'openai-codex-responses';
    }
  }
  config.auth = config.auth || {};
  config.auth.profiles = config.auth.profiles || {};
  config.auth.order = config.auth.order || {};

  // moltbot.json schema only accepts mode (not type) and no actual token fields.
  // The actual OAuth token is injected into per-agent auth-profiles.json separately
  // via injectCodexTokenToAgentAuthProfiles() below.
  // NOTE: do NOT delete openai-codex:codex-cli — it's the canonical rotation slot
  // for account-1; the inject below overwrites it with the real OAuth token each provision.

  // Account definitions: suffix -> profileId
  // openai-codex:codex-cli is the established rotation name for account-1 (suffix '').
  const CODEX_ACCOUNTS = [
    { suffix: '', profileId: 'openai-codex:codex-cli' },
    { suffix: '-2', profileId: 'openai-codex:account-2' },
    { suffix: '-3', profileId: 'openai-codex:account-3' },
  ];

  const credentials = [];
  try {
    const secretResponse = await k8sApi.readNamespacedSecret('api-keys', NAMESPACE);
    const secretData = secretResponse.body.data || {};
    const decode = (key) => (secretData[key] ? Buffer.from(secretData[key], 'base64').toString('utf8') : null);

    for (const { suffix, profileId } of CODEX_ACCOUNTS) {
      const access = decode(`openai-codex-access-token${suffix}`);
      if (!access) continue; // account not configured
      const refresh = decode(`openai-codex-refresh-token${suffix}`);
      const expiresAt = decode(`openai-codex-expires-at${suffix}`);
      if (!config.auth.profiles[profileId]) {
        config.auth.profiles[profileId] = { provider: 'openai-codex', mode: 'oauth' };
      }
      credentials.push({
        profileId,
        credential: {
          type: 'oauth',
          provider: 'openai-codex',
          access,
          ...(refresh && { refresh }),
          // Parse ISO date string to milliseconds; Number() of ISO string gives NaN
          ...(expiresAt && { expires: new Date(expiresAt).getTime() || null }),
        },
      });
    }
  } catch (_err) {
    // Not in k8s mode or secret unavailable
  }

  // Set auth.order to all configured accounts (enables rotation on rate-limit)
  config.auth.order['openai-codex'] = credentials.length > 0
    ? credentials.map((c) => c.profileId)
    : ['openai-codex:codex-cli'];

  // Ensure at least the default profile stub exists
  if (!config.auth.profiles['openai-codex:codex-cli']) {
    config.auth.profiles['openai-codex:codex-cli'] = { provider: 'openai-codex', mode: 'oauth' };
  }

  return credentials.length > 0 ? credentials : null;
};

// Returns a gateway pod that is fully Ready (init containers done, main container running).
// Polls up to timeoutMs (default 90s) so injections survive a gateway rolling restart.
const waitForReadyGatewayPod = async (timeoutMs = 90000, pollIntervalMs = 5000) => {
  const isReady = (pod) => {
    if (pod.status?.phase !== 'Running') return false;
    const conditions = pod.status?.conditions || [];
    return conditions.some((c) => c.type === 'Ready' && c.status === 'True');
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gwPods = await k8sApi.listNamespacedPod(
      NAMESPACE, undefined, undefined, undefined, undefined, 'app=clawdbot-gateway',
    );
    const pod = gwPods.body.items.find(isReady);
    if (pod) return pod;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return null;
};

const injectCodexTokenToAgentAuthProfiles = async (deploymentName, agentId, credentials) => {
  // credentials: array of { profileId, credential } or null
  if (!credentials || credentials.length === 0) return;
  const assignments = credentials
    .map(({ profileId, credential }) => `store.profiles['${profileId}'] = ${JSON.stringify(credential).replace(/'/g, "'\\''")};`)
    .join(' ');
  const profileIds = JSON.stringify(credentials.map((c) => c.profileId));
  const script = [
    `const fs = require('fs');`,
    `const p = '/state/agents/${agentId}/agent/auth-profiles.json';`,
    `try {`,
    `  const store = JSON.parse(fs.readFileSync(p, 'utf8'));`,
    `  ${assignments}`,
    `  store.order = store.order || {};`,
    `  const existing = store.order['openai-codex'] || [];`,
    `  const injected = ${profileIds};`,
    `  store.order['openai-codex'] = Array.from(new Set([...injected, ...existing]));`,
    `  fs.writeFileSync(p, JSON.stringify(store, null, 2));`,
    `  process.stdout.write('ok');`,
    `} catch(e) { process.stdout.write('skip:' + e.message); }`,
  ].join(' ');

  const execOnPod = async (podName) => new Promise((resolve, reject) => {
    // stdout captures script output. stdin MUST be null — passing any stream (even an
    // ended PassThrough) keeps the stdin WebSocket channel open and stalls the status
    // callback, causing the Promise to never settle.
    const stdoutStream = new stream.PassThrough();
    k8sExec.exec(
      NAMESPACE,
      podName,
      'clawdbot-gateway',
      ['node', '-e', script],
      stdoutStream,
      stdoutStream,
      null,
      false,
      (status) => {
        if (status.status === 'Success') resolve();
        else reject(new Error(status.message || 'exec failed'));
      },
    ).catch(reject);
  });

  // Reprovision-all restarts the gateway mid-flow; the injection may run while the new pod
  // is still initialising. Wait up to 90s for a Ready pod, then retry the exec once on
  // failure so transient 500s during pod startup don't permanently skip the order update.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const gwPod = await waitForReadyGatewayPod(90000, 5000);
      if (!gwPod) {
        console.warn(`[k8s-provisioner] codex token inject skipped for ${agentId}: no ready gateway pod after 90s`);
        return;
      }
      const podName = gwPod.metadata.name;
      await execOnPod(podName);
      console.log(`[k8s-provisioner] codex token injected for ${agentId} into ${podName}`);
      return;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[k8s-provisioner] codex token inject attempt ${attempt} failed for ${agentId}: ${err.message} — retrying`);
        await new Promise((r) => setTimeout(r, 10000));
      } else {
        console.warn(`[k8s-provisioner] codex token inject skipped for ${agentId}: ${err.message}`);
      }
    }
  }
};

const applyOpenClawModelDefaults = async (config) => {
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = config.agents.defaults.model || {};
  let modelConfig = null;
  try {
    modelConfig = await GlobalModelConfigService.getConfig({ includeSecrets: false });
  } catch (error) {
    modelConfig = null;
  }
  // OpenRouter fallbacks: free models only, explicit list enforced on every provision.
  // Nemotron is primary fallback, Trinity is secondary. No paid or Llama models.
  const OPENROUTER_FREE_FALLBACKS = [
    'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
    'openrouter/arcee-ai/trinity-large-preview:free',
  ];

  // Global default: nano for community agents (same Codex OAuth, 3-account rotation via LiteLLM).
  // Fallback to OpenRouter free models when nano quota is exhausted.
  // Dev agents get an explicit per-agent mini override (see devAgentModel below).
  config.agents.defaults.model.primary = 'openai-codex/gpt-5.4-nano';
  config.agents.defaults.model.fallbacks = Array.from(new Set([
    'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
    'openrouter/arcee-ai/trinity-large-preview:free',
    ...GEMINI_FALLBACKS,
  ]));

  // Always set up Codex provider config so dev agents can use it via per-agent override.
  const codexCredentials = await applyOpenClawCodexProviderConfig(config);

  // OpenRouter provider catalog — free models only, no paid models.
  // `api: "openai-completions"` is required: pi-ai uses it to route to the correct provider.
  // `reasoning`, `input`, `cost` are required fields in ModelDefinitionConfig.
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  config.models.providers.openrouter = {
    // Route through LiteLLM when available so all OpenRouter calls are visible in spend logs
    // and benefit from centralized failover. Falls back to direct OpenRouter if LiteLLM is absent.
    baseUrl: process.env.LITELLM_BASE_URL || 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
    models: [
      {
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        name: 'Nemotron Super 120B (free)',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 8000,
        contextWindow: 128000,
      },
      {
        id: 'arcee-ai/trinity-large-preview:free',
        name: 'Trinity Large (free)',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 8000,
        contextWindow: 32000,
      },
    ],
  };

  // Resolve dev agent IDs from DB (fallback to defaults if not set).
  const devAgentIds = Array.isArray(modelConfig?.openclaw?.devAgentIds) && modelConfig.openclaw.devAgentIds.length
    ? modelConfig.openclaw.devAgentIds
    : DEFAULT_DEV_AGENT_IDS;

  // Dev agents get an explicit Codex per-agent model override.
  // gpt-5.4-mini uses only 30% of the weekly Codex quota vs full gpt-5.4,
  // making it ideal for heartbeat orchestration (list pods, check tasks, post updates).
  // acpx_run coding tasks still use full gpt-5.4 via LiteLLM (hardcoded in tools.ts).
  const devAgentModel = {
    primary: 'openai-codex/gpt-5.4-mini',
    fallbacks: Array.from(new Set([...OPENROUTER_FREE_FALLBACKS, ...GEMINI_FALLBACKS])),
  };

  return { codexCredentials, devAgentIds, devAgentModel };
};

/**
 * Provision OpenClaw (moltbot) account in Kubernetes
 */
const provisionOpenClawAccount = async ({
  accountId,
  runtimeToken,
  userToken,
  agentName,
  instanceId,
  baseUrl,
  displayName,
  heartbeat,
  authProfiles,
  skillEnv,
  integrationChannels,
  configMapName = 'clawdbot-config',
  gateway,
}) => {
  const configKey = 'moltbot.json';

  // Read existing config
  const config = await readConfigMap(configMapName, configKey);

  // Update config structure (same logic as Docker version)
  config.channels = config.channels || {};
  config.channels.commonly = config.channels.commonly || {};
  config.channels.commonly.enabled = true;
  config.channels.commonly.baseUrl = config.channels.commonly.baseUrl || baseUrl || BACKEND_SERVICE_URL;
  config.channels.commonly.accounts = config.channels.commonly.accounts || {};
  // Enable thread-bound ACP sessions via the Commonly subagent-hooks
  if (!config.channels.commonly.threadBindings) {
    config.channels.commonly.threadBindings = { enabled: true, spawnSubagentSessions: true };
  }
  config.skills = config.skills || {};

  // Required since upstream v2026.2.26: non-loopback gateway requires either
  // allowedOrigins or dangerouslyAllowHostHeaderOriginFallback on controlUi.
  config.gateway = config.gateway || {};
  config.gateway.controlUi = config.gateway.controlUi || {};
  if (!config.gateway.controlUi.allowedOrigins && !config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback) {
    config.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
  }

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

  // Remove duplicate accounts
  Object.entries(config.channels.commonly.accounts).forEach(([key, entry]) => {
    if (!entry || key === accountId) return;
    const entryAgent = normalizeKey(entry.agentName, '');
    const entryInstance = normalizeKey(entry.instanceId, 'default');
    if (entryAgent === targetAgent && entryInstance === targetInstance) {
      delete config.channels.commonly.accounts[key];
      removedAccountIds.push(key);
    }
  });

  // Add/update account
  config.channels.commonly.accounts[accountId] = {
    runtimeToken: resolvedRuntimeToken,
    userToken: resolvedUserToken,
    agentName,
    instanceId,
    ...(authProfiles ? { authProfiles } : {}),
  };
  applyOpenClawIntegrationChannels(config, integrationChannels);
  applyOpenClawWebToolDefaults(config);
  applyOpenClawMemoryDefaults(config);
  applyOpenClawContextDefaults(config);
  applyOpenClawAcpxPluginDefaults(config);
  const { codexCredentials, devAgentIds, devAgentModel } = await applyOpenClawModelDefaults(config);

  const isDevAgent = devAgentIds.includes(accountId);
  let codexVirtualKey = null;
  if (isDevAgent) {
    // Only dev agents get Codex credentials. Community agents use OpenRouter/Gemini only
    // and must NOT have openai-codex:codex-cli keys — acpx_run uses that profile and would
    // burn shared Codex rate limits if community agents have access.
    if (process.env.LITELLM_BASE_URL) {
      // Issue a per-agent LiteLLM virtual key and inject it as the openai-codex Bearer token.
      // LiteLLM authenticates the virtual key and routes to chatgpt/gpt-5.4 using its own
      // stored OAuth tokens — no raw OAuth token injection into per-agent PVC files needed.
      codexVirtualKey = await issueLiteLLMVirtualKey(accountId);
      if (codexVirtualKey) {
        // Inject the same virtual key into all 3 codex profiles. All 3 route to the same
        // LiteLLM model (openai-codex/gpt-5.4) which has 3 deployments (one per account);
        // LiteLLM's least-busy routing distributes and falls back between accounts
        // transparently. The gateway's profile rotation serves as a secondary fallback.
        // Far-future expires prevents clawdbot-auth-seed from overwriting virtual keys
        // with raw JWTs on gateway restarts (init container only overwrites if its token
        // expiry is later than the existing profile's expires field).
        const codexCredential = {
          type: 'oauth',
          provider: 'openai-codex',
          access: codexVirtualKey,
          expires: Date.now() + 365 * 24 * 3600 * 1000,
        };
        await injectCodexTokenToAgentAuthProfiles('clawdbot-gateway', accountId, [
          { profileId: 'openai-codex:codex-cli', credential: codexCredential },
          { profileId: 'openai-codex:account-2', credential: codexCredential },
          { profileId: 'openai-codex:account-3', credential: codexCredential },
        ]);
      } else {
        // LiteLLM key generation failed (e.g. DB disabled) — use master key so agents
        // still route through LiteLLM instead of burning raw Codex OAuth tokens directly.
        const masterKey = (process.env.LITELLM_MASTER_KEY || '').trim();
        if (masterKey) {
          const masterCredential = {
            type: 'oauth',
            provider: 'openai-codex',
            access: masterKey,
            expires: Date.now() + 365 * 24 * 3600 * 1000,
          };
          await injectCodexTokenToAgentAuthProfiles('clawdbot-gateway', accountId, [
            { profileId: 'openai-codex:codex-cli', credential: masterCredential },
            { profileId: 'openai-codex:account-2', credential: masterCredential },
            { profileId: 'openai-codex:account-3', credential: masterCredential },
          ]);
        } else {
          // No master key either — fall back to raw OAuth token injection
          await injectCodexTokenToAgentAuthProfiles('clawdbot-gateway', accountId, codexCredentials);
        }
      }
    } else {
      await injectCodexTokenToAgentAuthProfiles('clawdbot-gateway', accountId, codexCredentials);
    }
  }

  // Route OpenRouter calls through LiteLLM for all agents when LiteLLM is available.
  // openrouter.baseUrl is set to LiteLLM in applyOpenClawModelDefaults, so the gateway
  // will send openrouter/... model requests to LiteLLM — which requires a virtual key.
  // Dev agents reuse their Codex virtual key (it already grants OpenRouter model access).
  // Community agents get a separate key scoped to OpenRouter models only (no Codex).
  if (process.env.LITELLM_BASE_URL) {
    const masterKey = (process.env.LITELLM_MASTER_KEY || '').trim();
    const openRouterKey = isDevAgent
      ? codexVirtualKey // reuse — already has openrouter/* in models scope
      : (await issueLiteLLMOpenRouterKey(accountId)) || masterKey || null;
    if (openRouterKey) {
      await injectOpenRouterKeyToAgentAuthProfiles('clawdbot-gateway', accountId, openRouterKey);
    }
  }
  applySkillEnvEntriesToConfig(config, skillEnv);

  // Update agents list
  config.agents = config.agents || {};
  config.agents.list = Array.isArray(config.agents.list) ? config.agents.list : [];
  if (removedAccountIds.length) {
    config.agents.list = config.agents.list.filter(
      (agent) => !removedAccountIds.includes(agent?.id),
    );
  }

  // Workspace path for K8s
  const desiredWorkspace = `/workspace/${accountId}`;

  const normalizeHeartbeat = (payload) => {
    if (!payload || payload.enabled === false) return null;
    const minutes = Number(payload.everyMinutes || payload.every || payload.intervalMinutes);
    const every = Number.isFinite(minutes) && minutes > 0 ? `${minutes}m` : payload.every;
    const session = String(payload.session || '').trim() || 'heartbeat';
    return {
      every: every || '60m',
      prompt: payload.prompt || DEFAULT_HEARTBEAT_PROMPT,
      target: payload.target || 'commonly',
      session,
    };
  };

  const agentEntry = config.agents.list.find((agent) => agent?.id === accountId);
  const heartbeatConfig = normalizeHeartbeat(heartbeat);

  // Per-agent model override: dev agents get explicit Codex config.
  // Community agents use global default (nemotron) — no per-agent entry needed.
  const perAgentModel = devAgentIds.includes(accountId) ? devAgentModel : null;

  if (agentEntry) {
    if (agentEntry.workspace !== desiredWorkspace) {
      agentEntry.workspace = desiredWorkspace;
    }
    if (!agentEntry.name) {
      agentEntry.name = displayName || agentName || accountId;
    }
    if (heartbeatConfig) {
      agentEntry.heartbeat = heartbeatConfig;
    } else if (!heartbeat && agentEntry.heartbeat) {
      // Only remove gateway-autonomous heartbeat when heartbeat is entirely absent (null),
      // not when it is explicitly disabled (enabled: false) — prevents per-pod disabled
      // installations from clobbering the shared gateway heartbeat entry during reprovision-all.
      delete agentEntry.heartbeat;
    }
    if (perAgentModel) {
      agentEntry.model = perAgentModel;
    } else {
      delete agentEntry.model; // community agents: use global default (nemotron)
    }
  } else {
    config.agents.list.push({
      id: accountId,
      name: displayName || agentName || accountId,
      workspace: desiredWorkspace,
      ...(heartbeatConfig ? { heartbeat: heartbeatConfig } : {}),
      ...(perAgentModel ? { model: perAgentModel } : {}),
    });
  }

  // Update bindings
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

  // Write updated config to ConfigMap
  await writeConfigMap(configMapName, configKey, config);

  // Also sync to /state/moltbot.json on the gateway PVC so the init container
  // (clawdbot-auth-seed) picks up the account on next gateway restart.
  try {
    const accountEntry = config.channels.commonly.accounts[accountId];
    const agentEntry = config.agents.list.find((a) => a?.id === accountId) || null;
    const bindingEntry = config.bindings.find((b) => b?.match?.accountId === accountId) || null;
    await syncAccountToStateMoltbot(accountId, accountEntry, agentEntry, bindingEntry, { gateway });
    console.log(`[k8s-provisioner] synced ${accountId} to /state/moltbot.json`);
  } catch (err) {
    console.warn('[k8s-provisioner] Failed to sync account to /state/moltbot.json:', err.message);
  }

  try {
    const heartbeatPath = await ensureHeartbeatTemplate(accountId, heartbeat, {
      gateway,
      customContent: heartbeat?.customContent || null,
      // Force-overwrite only when explicitly declared via presetId (not just instanceId match)
      forceOverwrite: Boolean(heartbeat?.forceOverwrite),
    });
    if (heartbeatPath) {
      console.log(`[k8s-provisioner] ensured heartbeat template for ${accountId}: ${heartbeatPath}`);
    }
  } catch (error) {
    console.warn('[k8s-provisioner] Failed to ensure HEARTBEAT.md template:', error.message);
  }
  try {
    const soulPath = await ensureWorkspaceSoulFile(accountId, heartbeat?.soulContent, { gateway });
    if (soulPath) {
      console.log(`[k8s-provisioner] wrote SOUL.md for ${accountId}: ${soulPath}`);
    }
  } catch (error) {
    console.warn('[k8s-provisioner] Failed to write SOUL.md:', error.message);
  }
  try {
    const normalizedPath = await normalizeWorkspaceDocs(accountId, { gateway });
    if (normalizedPath) {
      console.log(`[k8s-provisioner] normalized workspace docs for ${accountId}: ${normalizedPath}`);
    }
  } catch (error) {
    console.warn('[k8s-provisioner] Failed to normalize workspace docs:', error.message);
  }
  try {
    const memoryPath = await ensureWorkspaceMemoryFiles(accountId, { gateway });
    if (memoryPath) {
      console.log(`[k8s-provisioner] ensured memory files for ${accountId}: ${memoryPath}`);
    }
  } catch (error) {
    console.warn('[k8s-provisioner] Failed to ensure workspace memory files:', error.message);
  }

  return {
    configMap: configMapName,
    accountId,
    restartRequired: true,
  };
};

/**
 * Provision Commonly Bot (internal) account in Kubernetes
 */
const provisionCommonlyBotAccount = async ({
  accountId,
  runtimeToken,
  userToken,
  agentName,
  instanceId,
}) => {
  const configMapName = 'commonly-bot-config';
  const configKey = 'runtime.json';

  const config = await readConfigMap(configMapName, configKey);
  config.accounts = config.accounts || {};
  config.accounts[accountId] = {
    runtimeToken,
    userToken,
    agentName,
    instanceId,
  };

  await writeConfigMap(configMapName, configKey, config);

  return {
    configMap: configMapName,
    accountId,
    restartRequired: false,
  };
};

/**
 * Build Kubernetes Deployment manifest for agent runtime
 */
const buildAgentDeploymentManifest = ({
  runtimeType,
  accountId,
  agentName,
  instanceId,
}) => {
  const labels = {
    app: `agent-${runtimeType}`,
    'agent-type': runtimeType,
    'agent-name': agentName,
    'agent-instance': instanceId,
    'agent-account': accountId,
  };

  const deploymentName = `agent-${runtimeType}-${accountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  let containerSpec;
  let volumes = [];

  if (runtimeType === 'moltbot') {
    containerSpec = {
      name: 'clawdbot-gateway',
      image: process.env.CLAWDBOT_IMAGE || 'clawdbot:latest',
      imagePullPolicy: 'IfNotPresent',
      env: [
        { name: 'CLAWDBOT_GATEWAY_PORT', value: '18789' },
        { name: 'CLAWDBOT_BRIDGE_PORT', value: '18790' },
        {
          name: 'CLAWDBOT_GATEWAY_TOKEN',
          valueFrom: {
            secretKeyRef: {
              name: 'api-keys',
              key: 'clawdbot-gateway-token',
            },
          },
        },
        { name: 'CLAWDBOT_CONFIG_DIR', value: '/config' },
        { name: 'CLAWDBOT_WORKSPACE_DIR', value: '/workspace' },
        { name: 'COMMONLY_API_URL', value: BACKEND_SERVICE_URL },
        {
          name: 'BRAVE_API_KEY',
          valueFrom: {
            secretKeyRef: {
              name: 'api-keys',
              key: 'brave-api-key',
              optional: true,
            },
          },
        },
        {
          name: 'FIRECRAWL_API_KEY',
          valueFrom: {
            secretKeyRef: {
              name: 'api-keys',
              key: 'firecrawl-api-key',
              optional: true,
            },
          },
        },
        {
          name: 'DEEPGRAM_API_KEY',
          valueFrom: {
            secretKeyRef: {
              name: 'api-keys',
              key: 'deepgram-api-key',
              optional: true,
            },
          },
        },
      ],
      ports: [
        { containerPort: 18789, name: 'gateway' },
        { containerPort: 18790, name: 'bridge' },
      ],
      volumeMounts: [
        { name: 'clawdbot-config', mountPath: '/config', readOnly: true },
        { name: 'clawdbot-workspace', mountPath: '/workspace' },
      ],
      resources: {
        requests: { memory: '256Mi', cpu: '200m' },
        limits: { memory: '1Gi', cpu: '1000m' },
      },
    };

    volumes = [
      {
        name: 'clawdbot-config',
        configMap: { name: 'clawdbot-config' },
      },
      {
        name: 'clawdbot-workspace',
        persistentVolumeClaim: { claimName: 'clawdbot-workspace-pvc' },
      },
    ];
  } else if (runtimeType === 'internal') {
    containerSpec = {
      name: 'commonly-bot',
      image: 'node:20-alpine',
      imagePullPolicy: 'IfNotPresent',
      workingDir: '/app/external/commonly-agent-services/commonly-bot',
      env: [
        { name: 'COMMONLY_BASE_URL', value: BACKEND_SERVICE_URL },
        {
          name: 'COMMONLY_AGENT_TOKEN',
          valueFrom: {
            secretKeyRef: {
              name: 'api-keys',
              key: 'commonly-bot-runtime-token',
            },
          },
        },
        { name: 'COMMONLY_AGENT_POLL_MS', value: '5000' },
        { name: 'NODE_ENV', value: 'production' },
      ],
      volumeMounts: [
        { name: 'agent-services', mountPath: '/app/external/commonly-agent-services', readOnly: true },
        { name: 'commonly-bot-config', mountPath: '/app/config', readOnly: true },
      ],
      command: ['node', 'index.js'],
      resources: {
        requests: { memory: '128Mi', cpu: '100m' },
        limits: { memory: '512Mi', cpu: '500m' },
      },
    };

    volumes = [
      {
        name: 'agent-services',
        emptyDir: {}, // Will be populated by init container or ConfigMap
      },
      {
        name: 'commonly-bot-config',
        configMap: { name: 'commonly-bot-config' },
      },
    ];
  }

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: deploymentName,
      namespace: NAMESPACE,
      labels,
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: 'agent-provisioner',
          ...(AGENT_NODE_SELECTOR ? { nodeSelector: AGENT_NODE_SELECTOR } : {}),
          ...(AGENT_TOLERATIONS ? { tolerations: AGENT_TOLERATIONS } : {}),
          containers: [containerSpec],
          volumes,
        },
      },
    },
  };
};

/**
 * Provision agent runtime in Kubernetes
 */
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
  gateway,
}) => {
  console.log(`[k8s-provisioner] Provisioning ${runtimeType} agent: ${agentName}/${instanceId}`);

  let result;
  let accountId;
  let deploymentName = null;

  if (runtimeType === 'moltbot') {
    accountId = resolveOpenClawAccountId({ agentName, instanceId });
    result = await provisionOpenClawAccount({
      accountId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
      baseUrl,
      displayName,
      heartbeat,
      authProfiles,
      skillEnv,
      integrationChannels,
      configMapName: resolveGatewayConfigMapName(gateway),
      gateway,
    });
    // Use the shared clawdbot gateway deployment (no per-agent runtime pods).
    deploymentName = resolveGatewayDeploymentName(gateway);
  } else if (runtimeType === 'internal') {
    accountId = instanceId;
    result = await provisionCommonlyBotAccount({
      accountId,
      runtimeToken,
      userToken,
      agentName,
      instanceId,
    });
    deploymentName = `agent-${runtimeType}-${accountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    await cleanupLegacyInternalDeployment(deploymentName);
  } else if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    // External runtimes — no K8s deployment; agent manages its own compute
    return { provisioned: true, external: true, runtimeType };
  } else {
    throw new Error(`Provisioning not supported for runtime: ${runtimeType}`);
  }

  return {
    ...result,
    deployment: deploymentName,
    namespace: NAMESPACE,
    sharedGateway: runtimeType === 'moltbot',
  };
};

const resolveRuntimeDeploymentName = (runtimeType, instanceId, gateway) => {
  if (runtimeType === 'moltbot') {
    return resolveGatewayDeploymentName(gateway);
  }
  const accountId = instanceId;
  return `agent-${runtimeType}-${accountId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
};

const cleanupLegacyInternalDeployment = async (deploymentName) => {
  if (!deploymentName) return;
  try {
    await k8sAppsApi.deleteNamespacedDeployment(deploymentName, NAMESPACE);
    console.log(`[k8s-provisioner] Removed legacy internal deployment: ${deploymentName}`);
  } catch (error) {
    if (error?.response?.statusCode !== 404) {
      console.warn(`[k8s-provisioner] Failed to remove legacy internal deployment ${deploymentName}:`, error.message);
    }
  }
};

/**
 * Start agent runtime (scale to 1 replica)
 */
const startAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (runtimeType === 'moltbot') {
    const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);
    return { started: true, deployment: deploymentName, sharedGateway: true };
  }
  if (runtimeType === 'internal') {
    return { started: true, managedExternally: true, reason: 'internal runtime is config-only on k8s' };
  }
  if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    return { started: false, external: true, reason: 'external runtime — agent manages its own process' };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    deployment.spec.replicas = 1;
    await k8sAppsApi.replaceNamespacedDeployment(deploymentName, NAMESPACE, deployment);

    console.log(`[k8s-provisioner] Started agent runtime: ${deploymentName}`);
    return { started: true, deployment: deploymentName };
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to start ${deploymentName}:`, error.message);
    return { started: false, reason: error.message };
  }
};

/**
 * Stop agent runtime (scale to 0 replicas)
 */
const stopAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (runtimeType === 'moltbot') {
    const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);
    return { stopped: true, deployment: deploymentName, sharedGateway: true };
  }
  if (runtimeType === 'internal') {
    return { stopped: true, managedExternally: true, reason: 'internal runtime is config-only on k8s' };
  }
  if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    return { stopped: false, external: true, reason: 'external runtime — agent manages its own process' };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    deployment.spec.replicas = 0;
    await k8sAppsApi.replaceNamespacedDeployment(deploymentName, NAMESPACE, deployment);

    console.log(`[k8s-provisioner] Stopped agent runtime: ${deploymentName}`);
    return { stopped: true, deployment: deploymentName };
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to stop ${deploymentName}:`, error.message);
    return { stopped: false, reason: error.message };
  }
};

/**
 * Restart agent runtime (trigger rolling restart)
 */
const restartAgentRuntime = async (runtimeType, instanceId, options = {}) => {
  if (runtimeType === 'internal') {
    return { restarted: true, managedExternally: true, reason: 'internal runtime is config-only on k8s' };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    // Add restart annotation to trigger rolling restart
    deployment.spec.template.metadata = deployment.spec.template.metadata || {};
    deployment.spec.template.metadata.annotations = deployment.spec.template.metadata.annotations || {};
    deployment.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'] = new Date().toISOString();

    await k8sAppsApi.replaceNamespacedDeployment(deploymentName, NAMESPACE, deployment);

    console.log(`[k8s-provisioner] Restarted agent runtime: ${deploymentName}`);
    return { restarted: true, deployment: deploymentName, sharedGateway: runtimeType === 'moltbot' };
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to restart ${deploymentName}:`, error.message);
    return { restarted: false, reason: error.message, sharedGateway: runtimeType === 'moltbot' };
  }
};

/**
 * Get agent runtime status
 */
const getAgentRuntimeStatus = async (runtimeType, instanceId, options = {}) => {
  if (runtimeType === 'webhook' || runtimeType === 'claude-code') {
    return { status: 'external', reason: 'agent manages its own compute' };
  }
  if (runtimeType === 'moltbot') {
    const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);
    try {
      const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
      const deployment = response.body;
      const replicas = deployment.spec.replicas || 0;
      const availableReplicas = deployment.status.availableReplicas || 0;
      const readyReplicas = deployment.status.readyReplicas || 0;

      let status = 'unknown';
      if (replicas === 0) status = 'stopped';
      else if (availableReplicas === replicas && readyReplicas === replicas) status = 'running';
      else if (availableReplicas > 0) status = 'starting';
      else status = 'pending';

      return {
        status,
        deployment: deploymentName,
        replicas,
        availableReplicas,
        readyReplicas,
        sharedGateway: true,
      };
    } catch (error) {
      return { status: 'not_found', deployment: deploymentName, sharedGateway: true };
    }
  }
  if (runtimeType === 'internal') {
    return {
      status: 'managed-externally',
      deployment: null,
      replicas: 0,
      availableReplicas: 0,
      readyReplicas: 0,
      reason: 'internal runtime is config-only on k8s',
    };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    const response = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const deployment = response.body;

    const replicas = deployment.spec.replicas || 0;
    const availableReplicas = deployment.status.availableReplicas || 0;
    const readyReplicas = deployment.status.readyReplicas || 0;

    let status = 'unknown';
    if (replicas === 0) {
      status = 'stopped';
    } else if (availableReplicas === replicas && readyReplicas === replicas) {
      status = 'running';
    } else if (availableReplicas > 0) {
      status = 'starting';
    } else {
      status = 'pending';
    }

    return {
      status,
      deployment: deploymentName,
      replicas,
      availableReplicas,
      readyReplicas,
    };
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      return { status: 'not-found', deployment: deploymentName };
    }
    return { status: 'error', reason: error.message };
  }
};

/**
 * Get agent runtime logs
 */
const getDeploymentLogs = async ({ deploymentName, lines, filterTokens = [] }) => {
  try {
    const deploymentResponse = await k8sAppsApi.readNamespacedDeployment(deploymentName, NAMESPACE);
    const matchLabels = deploymentResponse.body?.spec?.selector?.matchLabels || {};
    const labelSelector = Object.entries(matchLabels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');

    const podsResponse = await k8sApi.listNamespacedPod(
      NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector || undefined,
    );
    const pods = podsResponse.body.items || [];
    if (!pods.length) {
      return { logs: '', reason: 'No pods found for deployment' };
    }
    const pod = pods[0];
    const logsResponse = await k8sApi.readNamespacedPodLog(
      pod.metadata.name,
      NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lines,
    );
    let logs = logsResponse.body || '';
    const tokens = (filterTokens || []).map((t) => String(t || '').trim()).filter(Boolean);
    if (tokens.length) {
      logs = logs
        .split('\n')
        .filter((line) => {
          if (!line) return false;
          if (tokens.some((token) => line.includes(`[commonly] [${token}]`))) return true;
          if (tokens.some((token) => line.includes(token))) return true;
          return false;
        })
        .join('\n');
    }
    return { logs, pod: pod.metadata.name, deployment: deploymentName };
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to get logs for ${deploymentName}:`, error.message);
    return { logs: '', reason: error.message };
  }
};

const getAgentRuntimeLogs = async (
  runtimeType,
  instanceId,
  lines = 200,
  options = {},
) => {
  if (runtimeType === 'moltbot') {
    const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);
    const filterTokens = options.filterTokens || [];
    return getDeploymentLogs({ deploymentName, lines, filterTokens });
  }
  if (runtimeType === 'internal') {
    return {
      logs: 'No deployment logs: internal runtime is config-only on k8s.',
      status: 'managed-externally',
    };
  }
  const deploymentName = resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway);

  try {
    // Find pods for this deployment
    return getDeploymentLogs({ deploymentName, lines });
  } catch (error) {
    console.error(`[k8s-provisioner] Failed to get logs for ${deploymentName}:`, error.message);
    return { logs: '', reason: error.message };
  }
};

/**
 * Returns session directory sizes in bytes for all agents on the gateway.
 * @returns {Promise<Array<{accountId: string, bytes: number}>>}
 */
const getAgentSessionSizes = async (options = {}) => {
  const podName = await resolveGatewayPodNameWithRetry(options.gateway);
  const script = [
    'set -eu',
    'for dir in /state/agents/*/sessions; do',
    '  [ -d "$dir" ] || continue',
    '  id=$(echo "$dir" | sed "s|/state/agents/||;s|/sessions||")',
    '  size=$(du -sk "$dir" 2>/dev/null | cut -f1)',
    '  echo "$id $size"',
    'done',
  ].join('\n');

  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });

  return String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [accountId, kb] = line.split(/\s+/);
      return { accountId, bytes: Number(kb || 0) * 1024 };
    })
    .filter((entry) => entry.accountId && Number.isFinite(entry.bytes));
};

const clearAgentRuntimeSessions = async (runtimeType, instanceId, options = {}) => {
  if (runtimeType !== 'moltbot') {
    return {
      cleared: false,
      reason: 'Session clearing is only supported for OpenClaw runtimes.',
      runtimeType,
    };
  }

  const accountId = String(options.accountId || instanceId || '').trim();
  if (!accountId) {
    throw new Error('accountId is required to clear runtime sessions');
  }

  const podName = await resolveGatewayPodNameWithRetry(options.gateway);
  const targets = [
    `/state/agents/${accountId}/sessions`,
    `/state/agents/${accountId}/sessions.json`,
    `/state/agents/${accountId}/sessions.jsonl`,
  ];

  const script = [
    'set -eu',
    'removed=""',
    ...targets.map((target) => [
      `if [ -e "${target}" ]; then`,
      `  rm -rf "${target}"`,
      `  removed="${target}\\n$removed"`,
      'fi',
    ].join('\n')),
    // Recreate sessions dir so any in-flight session writes don't ENOENT-crash the gateway
    `mkdir -p "/state/agents/${accountId}/sessions"`,
    'printf "%s" "$removed"',
  ].join('\n');

  const result = await execInPod({
    podName,
    containerName: 'clawdbot-gateway',
    command: ['sh', '-lc', script],
  });

  const removed = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    cleared: true,
    accountId,
    removed,
    pod: podName,
    deployment: resolveRuntimeDeploymentName(runtimeType, instanceId, options.gateway),
  };
};

/**
 * Refresh a single Codex OAuth account by its secret key suffix.
 * suffix='' → account 1 (keys: openai-codex-*, profile: openai-codex:codex-cli)
 * suffix='-2' → account 2 (keys: openai-codex-*-2, profile: openai-codex:account-2)
 */
const refreshCodexOAuthTokenForAccount = async (secretData, suffix) => {
  const decode = (key) => (secretData[key] ? Buffer.from(secretData[key], 'base64').toString('utf8') : null);
  const profileId = suffix === '-2' ? 'openai-codex:account-2' : 'openai-codex:codex-cli';
  const refreshToken = decode(`openai-codex-refresh-token${suffix}`);
  const clientId = decode('openai-codex-client-id') || process.env.OPENAI_CODEX_CLIENT_ID;

  if (!refreshToken) return null; // No token configured for this account

  const axios = require('axios');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...(clientId && { client_id: clientId }),
  });

  let tokenResponse;
  try {
    tokenResponse = await axios.post('https://auth.openai.com/oauth/token', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = JSON.stringify(err.response?.data || err.message);
    throw new Error(`[codex-refresh${suffix}] Token refresh failed (${status}): ${detail}`);
  }

  const { access_token, refresh_token: newRefreshToken, expires_in } = tokenResponse.data;
  if (!access_token) {
    throw new Error(`[codex-refresh${suffix}] No access_token in refresh response`);
  }

  const expiresAt = Date.now() + (expires_in || 3600) * 1000;
  const encode = (s) => Buffer.from(s).toString('base64');

  // Patch the k8s secret with new tokens for this account
  const patch = {
    data: {
      [`openai-codex-access-token${suffix}`]: encode(access_token),
      [`openai-codex-expires-at${suffix}`]: encode(String(expiresAt)),
      ...(newRefreshToken && { [`openai-codex-refresh-token${suffix}`]: encode(newRefreshToken) }),
    },
  };
  try {
    await k8sApi.patchNamespacedSecret('api-keys', NAMESPACE, patch, undefined, undefined, undefined, undefined, undefined, {
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });
    console.log(`[codex-refresh${suffix}] Secret patched. Expires at ${new Date(expiresAt).toISOString()}`);
  } catch (err) {
    throw new Error(`[codex-refresh${suffix}] Failed to patch api-keys secret: ${err.message}`);
  }

  // Also update GCP Secret Manager so ESO doesn't overwrite k8s secret on next sync
  try {
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
    const smClient = new SecretManagerServiceClient();
    const project = process.env.GCP_PROJECT_ID || 'YOUR_GCP_PROJECT_ID';
    const toUpdate = {
      [`openai-codex-access-token${suffix}`]: access_token,
      [`openai-codex-expires-at${suffix}`]: String(expiresAt),
      ...(newRefreshToken && { [`openai-codex-refresh-token${suffix}`]: newRefreshToken }),
    };
    await Promise.all(
      Object.entries(toUpdate).map(([key, value]) =>
        smClient.addSecretVersion({
          parent: `projects/${project}/secrets/commonly-dev-${key}`,
          payload: { data: Buffer.from(value) },
        }),
      ),
    );
    console.log(`[codex-refresh${suffix}] GCP Secret Manager updated.`);
  } catch (err) {
    // Re-throw so the caller knows GCP SM failed — silent swallow causes ESO to revert
    // the k8s secret to the old (consumed) refresh token on next 1h sync, permanently
    // breaking the refresh chain.
    console.error(`[codex-refresh${suffix}] GCP Secret Manager update FAILED: ${err.message}`);
    throw err;
  }

  // Re-inject into all agent auth-profiles.json on the gateway PVC.
  // NOTE: Do NOT patch CODEX_API_KEY — forces codex-api-key mode which lacks api.responses.write scope.
  const credential = {
    type: 'oauth',
    provider: 'openai-codex',
    access: access_token,
    refresh: newRefreshToken || refreshToken,
    expires: expiresAt,
  };
  const credJson = JSON.stringify(credential).replace(/'/g, "'\\''");

  // Account 1 also updates ~/.codex/auth.json used by acpx chatgpt auth mode.
  const isAccount1 = suffix === '';
  const codexAuthJson = isAccount1
    ? JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token,
          refresh_token: newRefreshToken || refreshToken,
        },
        last_refresh: new Date().toISOString(),
      }).replace(/'/g, "'\\''")
    : null;

  // When LiteLLM proxies Codex, agents' auth-profiles.json contains a stable virtual key —
  // do NOT overwrite it with the raw OAuth token. Only update .codex/auth.json (needed by
  // the acpx coding tool which authenticates directly, not via LiteLLM).
  const useLiteLLM = !!process.env.LITELLM_BASE_URL;

  try {
    const gwPods = await k8sApi.listNamespacedPod(NAMESPACE, undefined, undefined, undefined, undefined, 'app=clawdbot-gateway');
    const gwPod = gwPods.body.items.find((p) => p.status?.phase === 'Running');
    // When using LiteLLM, only account 1 needs to run (for .codex/auth.json); accounts 2/3 skip.
    if (gwPod && (!useLiteLLM || isAccount1)) {
      const script = [
        `const fs = require('fs'), path = require('path');`,
        `const base = '/state/agents';`,
        `let count = 0;`,
        `try {`,
        `  const agents = fs.readdirSync(base);`,
        `  for (const a of agents) {`,
        // Skip auth-profiles.json update when LiteLLM is enabled (virtual keys are stable)
        ...(!useLiteLLM
          ? [
              `    try {`,
              `      const p = path.join(base, a, 'agent', 'auth-profiles.json');`,
              `      const store = JSON.parse(fs.readFileSync(p, 'utf8'));`,
              `      store.profiles['${profileId}'] = ${credJson};`,
              `      fs.writeFileSync(p, JSON.stringify(store, null, 2));`,
              `      count++;`,
              `    } catch (_) {}`,
            ]
          : []),
        ...(isAccount1
          ? [
              `    try {`,
              `      const d = path.join(base, a, '.codex');`,
              `      fs.mkdirSync(d, { recursive: true });`,
              `      fs.writeFileSync(path.join(d, 'auth.json'), '${codexAuthJson}');`,
              `    } catch (_) {}`,
            ]
          : []),
        `  }`,
        `} catch (_) {}`,
        ...(isAccount1
          ? [
              `try { fs.mkdirSync('/state/.codex', { recursive: true }); fs.writeFileSync('/state/.codex/auth.json', '${codexAuthJson}'); } catch (_) {}`,
              `try { fs.mkdirSync('/home/node/.codex', { recursive: true }); fs.writeFileSync('/home/node/.codex/auth.json', '${codexAuthJson}'); } catch (_) {}`,
            ]
          : []),
        `process.stdout.write('updated:' + count);`,
      ].join(' ');
      await new Promise((resolve, reject) => {
        k8sExec.exec(
          NAMESPACE,
          gwPod.metadata.name,
          'clawdbot-gateway',
          ['node', '-e', script],
          null,
          process.stderr,
          process.stdin,
          false,
          (status) => {
            console.log(`[codex-refresh${suffix}] auth files re-inject: ${status.status}`);
            resolve();
          },
        ).catch(reject);
      });
    }
  } catch (err) {
    console.warn(`[codex-refresh${suffix}] auth files re-inject skipped: ${err.message}`);
  }

  // When LiteLLM proxies Codex, restart it so it picks up the freshly patched api-keys secret.
  // All accounts need this since all 3 accounts now use api_key from env vars directly (no auth.json).
  if (useLiteLLM) {
    try {
      await k8sAppsApi.patchNamespacedDeployment(
        'litellm',
        NAMESPACE,
        { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } } },
        undefined, undefined, undefined, undefined, undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
      );
      console.log('[codex-refresh] Triggered LiteLLM rollout restart to pick up refreshed token.');
    } catch (err) {
      console.warn(`[codex-refresh] LiteLLM restart skipped: ${err.message}`);
    }
  }

  return { expiresAt };
};

const refreshCodexOAuthToken = async () => {
  let secretData;
  try {
    const secretResponse = await k8sApi.readNamespacedSecret('api-keys', NAMESPACE);
    secretData = secretResponse.body.data || {};
  } catch (err) {
    throw new Error(`[codex-refresh] Failed to read api-keys secret: ${err.message}`);
  }
  return refreshCodexOAuthTokenForAccount(secretData, '');
};

/**
 * Refresh any Codex OAuth account whose token expires within the threshold.
 * Checks account-1 and account-2 independently. Safe to call from a daily cron.
 */
const refreshCodexOAuthTokenIfNeeded = async ({ thresholdDays = 3 } = {}) => {
  let secretData;
  try {
    const secretResponse = await k8sApi.readNamespacedSecret('api-keys', NAMESPACE);
    secretData = secretResponse.body.data || {};
  } catch (_err) {
    return null; // Not in k8s mode
  }

  const decode = (key) => (secretData[key] ? Buffer.from(secretData[key], 'base64').toString('utf8') : null);
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const results = [];

  for (const suffix of ['', '-2', '-3']) {
    const expiresAtRaw = decode(`openai-codex-expires-at${suffix}`);
    if (!expiresAtRaw) continue; // No token configured for this account
    const expiresAt = Number(expiresAtRaw);
    if (expiresAt - Date.now() > thresholdMs) continue; // Still fresh
    try {
      const result = await refreshCodexOAuthTokenForAccount(secretData, suffix);
      if (result) results.push({ suffix: suffix || '1', ...result });
    } catch (err) {
      console.error(`[codex-refresh${suffix}] ${err.message}`);
    }
  }

  return results.length > 0 ? results : null;
};

module.exports = {
  getAgentSessionSizes,
  provisionAgentRuntime,
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
  clearAgentRuntimeSessions,
  resolveOpenClawAccountId,
  writeOpenClawHeartbeatFile,
  readOpenClawHeartbeatFile,
  readOpenClawIdentityFile,
  writeWorkspaceIdentityFile,
  ensureWorkspaceIdentityFile,
  ensureWorkspaceSoulFile,
  ensureHeartbeatTemplate,
  syncOpenClawSkills,
  getGatewaySkillEntries,
  syncGatewaySkillEnv,
  listOpenClawBundledSkills,
  listOpenClawPlugins,
  installOpenClawPlugin,
  refreshCodexOAuthToken,
  refreshCodexOAuthTokenIfNeeded,
};
