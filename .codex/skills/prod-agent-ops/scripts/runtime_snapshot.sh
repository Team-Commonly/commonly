#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ] || [ "${2:-}" = "" ]; then
  echo "usage: $0 <base_url> <admin_token>"
  exit 1
fi

BASE_URL="${1%/}"
TOKEN="$2"

node - "$BASE_URL" "$TOKEN" <<'NODE'
const baseUrl = process.argv[2];
const token = process.argv[3];

const req = async (path) => {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
};

const print = (label, value) => {
  console.log(`${label}: ${JSON.stringify(value)}`);
};

(async () => {
  const health = await fetch(`${baseUrl}/api/health`).then(async (res) => {
    const txt = await res.text();
    try { return { status: res.status, body: JSON.parse(txt) }; } catch { return { status: res.status, body: {} }; }
  });
  print('health', { status: health.status, timestamp: health.body?.timestamp || null });

  const me = await req('/api/auth/user');
  print('actor', {
    status: me.status,
    id: me.body?._id || null,
    username: me.body?.username || null,
    role: me.body?.role || null,
  });

  const events = await req('/api/admin/agents/events?limitPending=50&limitRecent=50');
  print('queue', {
    status: events.status,
    pending: events.body?.queue?.pending ?? null,
    delivered: events.body?.queue?.delivered ?? null,
    failed: events.body?.queue?.failed ?? null,
    stalePendingCount: events.body?.queue?.stalePendingCount ?? null,
    pendingByAgent: events.body?.pendingByAgent || [],
  });

  const installs = await req('/api/registry/admin/installations?limit=200');
  const list = installs.body?.installations || [];
  print('installations', {
    status: installs.status,
    total: installs.body?.total ?? null,
    active: list.filter((i) => i.status === 'active').length,
    openclaw: list.filter((i) => i.agentName === 'openclaw').length,
  });

  const openclaw = list.filter((i) => i.agentName === 'openclaw').slice(0, 20);
  const statusRows = [];
  for (const inst of openclaw) {
    const podId = inst?.pod?.id;
    const agentName = inst?.agentName;
    const instanceId = inst?.instanceId || 'default';
    if (!podId || !agentName) continue;
    const path = `/api/registry/pods/${podId}/agents/${encodeURIComponent(agentName)}/runtime-status?instanceId=${encodeURIComponent(instanceId)}`;
    const runtime = await req(path);
    statusRows.push({
      podId,
      agentName,
      instanceId,
      status: runtime.status,
      body: runtime.body?.status || runtime.body?.message || runtime.body?.error || null,
    });
  }
  print('runtimeStatus', statusRows);
})();
NODE
