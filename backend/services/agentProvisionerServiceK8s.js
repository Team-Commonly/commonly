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
  '- If the `commonly` skill is available, read and follow `./skills/commonly/SKILL.md` in this agent workspace.',
  '- Resolve `podId` from the incoming runtime event payload. Do not use placeholder pod ids.',
  '- Fetch last 8 chat messages and 4 recent posts using runtime-token routes: `/api/agents/runtime/pods/:podId/messages?limit=8` and `/api/posts?podId=:podId&limit=4`.',
  '- Read recent activity and decide naturally whether to engage — like a team member checking the group chat.',
  '- If a real (non-bot) user asked a question or shared an opinion, respond to it directly with your actual thoughts. Do not just summarize or restate what they said.',
  '- If there is an interesting discussion underway, weigh in with your perspective.',
  '- If you have something relevant from your domain or feeds worth sharing, bring it up.',
  '- For social/curator agents: check `GET /api/posts?category=Social` for feed content. If empty or stale, use `web_search` (if available) to find trending content before concluding there is nothing to share.',
  '- Only stay quiet (reply `HEARTBEAT_OK`) if there is genuinely nothing worth contributing.',
  '- SILENT WORK RULE: Do NOT post anything to pod chat while fetching data or analyzing activity. Work silently first, then post ONE message only if you have something genuine to say. No intermediate progress messages.',
  '- HEARTBEAT_OK is a return value, NOT a chat message. Never post "HEARTBEAT_OK" or "No meaningful activity" or any similar phrase to pod chat. If staying quiet, simply return HEARTBEAT_OK as your sole output with zero chat messages posted.',
  '- Do not post housekeeping-only status updates (e.g. "no new activity", "latest activity from X", "I will follow up", "Fetching messages", "Analyzing activity").',
  '- IMPORTANT: If the commonly skill or runtime API is unavailable, reply `HEARTBEAT_OK` immediately. Do NOT use web_search or external search tools to look up pod activity — they have no access to internal pod data. Do not describe the failure.',
  '- Log short-term notes in memory/YYYY-MM-DD.md. Promote durable notes to MEMORY.md.',
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

const ensureHeartbeatTemplate = async (accountId, heartbeat, { gateway } = {}) => {
  if (!heartbeat || heartbeat.enabled === false) return null;
  const podName = await resolveGatewayPodNameWithRetry(gateway);
  const workspacePath = '/workspace';
  const heartbeatPath = `${workspacePath}/${accountId}/HEARTBEAT.md`;
  const encoded = Buffer.from(normalizeHeartbeatContent(DEFAULT_HEARTBEAT_CONTENT), 'utf8').toString('base64');
  const script = [
    'set -eu',
    `mkdir -p "${workspacePath}/${accountId}"`,
    `if [ -s "${heartbeatPath}" ]; then`,
    `  if grep -q "via user-token routes" "${heartbeatPath}" || grep -q "with runtime token, or \\\`/api/pods/:podId/context\\\` with user token" "${heartbeatPath}"; then`,
    `    printf '%s' '${encoded}' | base64 -d > "${heartbeatPath}"`,
    '  fi',
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
    // Agents list
    'd.setdefault("agents", {}).setdefault("list", [])',
    'ids = [a.get("id") for a in d["agents"]["list"]]',
    'if agent_entry and account_id not in ids: d["agents"]["list"].append(agent_entry); print("[state-sync] added agent:", account_id)',
    // Bindings
    'd.setdefault("bindings", [])',
    'bids = [b.get("match", {}).get("accountId") for b in d["bindings"]]',
    'if binding and account_id not in bids: d["bindings"].append(binding); print("[state-sync] added binding:", account_id)',
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
  const defaultPrimary = String(
    modelConfig?.openclaw?.model
    || modelConfig?.openclaw?.defaultModel
    || '',
  ).trim() || 'google/gemini-2.5-flash';
  const hasPolicyPrimary = Boolean(String(
    modelConfig?.openclaw?.model
    || modelConfig?.openclaw?.defaultModel
    || '',
  ).trim());
  const defaultFallbacks = Array.isArray(modelConfig?.openclaw?.fallbackModels)
    ? modelConfig.openclaw.fallbackModels
    : ['google/gemini-2.5-flash-lite', 'google/gemini-2.0-flash'];
  if (hasPolicyPrimary) {
    config.agents.defaults.model.primary = defaultPrimary;
  } else if (!config.agents.defaults.model.primary) {
    config.agents.defaults.model.primary = defaultPrimary;
  }
  const existingFallbacks = Array.isArray(config.agents.defaults.model.fallbacks)
    ? config.agents.defaults.model.fallbacks
    : [];
  const mergedFallbacks = [
    ...defaultFallbacks,
    ...existingFallbacks,
  ].filter(Boolean);
  config.agents.defaults.model.fallbacks = Array.from(new Set(mergedFallbacks));
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
  config.skills = config.skills || {};

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
  await applyOpenClawModelDefaults(config);

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
    const heartbeatPath = await ensureHeartbeatTemplate(accountId, heartbeat, { gateway });
    if (heartbeatPath) {
      console.log(`[k8s-provisioner] ensured heartbeat template for ${accountId}: ${heartbeatPath}`);
    }
  } catch (error) {
    console.warn('[k8s-provisioner] Failed to ensure HEARTBEAT.md template:', error.message);
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

module.exports = {
  provisionAgentRuntime,
  startAgentRuntime,
  stopAgentRuntime,
  restartAgentRuntime,
  getAgentRuntimeStatus,
  getAgentRuntimeLogs,
  clearAgentRuntimeSessions,
  resolveOpenClawAccountId,
  writeOpenClawHeartbeatFile,
  writeWorkspaceIdentityFile,
  ensureWorkspaceIdentityFile,
  ensureHeartbeatTemplate,
  syncOpenClawSkills,
  getGatewaySkillEntries,
  syncGatewaySkillEnv,
  listOpenClawBundledSkills,
  listOpenClawPlugins,
  installOpenClawPlugin,
};
