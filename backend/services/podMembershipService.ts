const Pod = require('../models/Pod');

export async function requirePodMember(podId: string, userId: unknown, { write = false, memberOnly = false } = {}): Promise<{ error?: string; status?: number; pod?: unknown; canWrite?: boolean }> {
  const pod = await Pod.findById(podId).lean() as { type?: string; members?: Array<{ userId?: { toString: () => string }; toString: () => string; role?: string }> } | null;
  if (!pod) return { error: 'Pod not found', status: 404 };
  const membership = pod.members?.find((m) => {
    if (!m) return false;
    const id = m.userId ? m.userId.toString() : m.toString();
    return id === (userId as { toString: () => string }).toString();
  });
  // Read access on agent-dm pods follows §3.7 (shared-pod readers
  // allowed). Write access stays member-only — non-members can observe
  // but not post tasks into someone else's bot-bot DM. The viewer-role
  // gate below applies to writes regardless.
  if (!membership) {
    if (write || memberOnly) return { error: 'Write access denied', status: 403 };
    // eslint-disable-next-line global-require
    const DMService = require('./dmService');
    const canView = await DMService.canViewPod(userId, pod);
    if (!canView) return { error: 'Access denied', status: 403 };
    return { pod, canWrite: false };
  }
  if (write && (membership as { role?: string }).role === 'viewer') return { error: 'Write access denied', status: 403 };
  return { pod, canWrite: (membership as { role?: string }).role !== 'viewer' };
}

