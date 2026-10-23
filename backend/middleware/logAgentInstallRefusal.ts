import { NextFunction, Request, Response } from 'express';

type RefusalBody = { code?: unknown; error?: unknown; message?: unknown; msg?: unknown };

// Only static response text is mapped. Unknown responses retain a bounded HTTP
// code rather than turning user-supplied error text into a log dimension.
const reasonByMessage: Record<string, string> = {
  'Agent not found in registry': 'agent_not_found_in_registry',
  'Agent identity not found': 'agent_identity_not_found',
  'Machine not found': 'machine_not_found',
  'Pod not found': 'pod_not_found',
  Unauthorized: 'unauthorized',
  'agentName required': 'agent_name_required',
  'agentName must be a string': 'agent_name_invalid',
  'machineId required (null to withdraw)': 'machine_id_required',
};

const runtimeTypes = new Set([
  'webhook', 'wrapper', 'hosted', 'native', 'moltbot', 'internal',
  'managed-agents', 'claude-code', 'codex',
]);

const credentialPrefix = /^(?:cm[_-]agent[_-]|gh[opurs][_-]|github[_-]pat[_-]|sk-|xox[abprs]-|bearer|eyj)/i;

const logIdentity = (value: unknown, allowScopedName = false): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  const valid = allowScopedName
    ? /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name)
    : /^[a-z0-9-]+$/.test(name);
  // Refused requests can supply credentials in place of names. Never "clean"
  // an invalid value into something that resembles a safe identity.
  if (!valid || name.length > 64 || credentialPrefix.test(name)) return '[redacted]';
  return name || null;
};

const logRuntimeType = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const runtimeType = value.trim().toLowerCase();
  return runtimeTypes.has(runtimeType) ? runtimeType : 'unknown';
};

const reasonCode = (body: RefusalBody, status: number): string => {
  if (typeof body.code === 'string'
    && /^[a-z][a-z0-9_]{0,79}$/.test(body.code)
    && !credentialPrefix.test(body.code)) return body.code;
  const message = body.error || body.message || body.msg;
  return typeof message === 'string' ? reasonByMessage[message] || `http_${status}` : `http_${status}`;
};

/** Record one structured line for each refused install or machine placement. */
export const logAgentInstallRefusal = (route: string, defaultRuntimeType?: string) => (
  req: Request & { user?: { id?: unknown } }, res: Response, next: NextFunction,
): void => {
  const originalJson = res.json.bind(res);
  let logged = false;
  res.json = ((body: RefusalBody) => {
    if (!logged && res.statusCode >= 400) {
      logged = true;
      const requestBody = req.body && typeof req.body === 'object' ? req.body : {};
      const runtime = requestBody.config?.runtime?.runtimeType || requestBody.runtimeType || defaultRuntimeType;
      console.warn('[agent-install-refused]', JSON.stringify({
        route,
        agentName: logIdentity(requestBody.agentName, true),
        instanceId: logIdentity(res.locals.agentInstallInstanceId || requestBody.instanceId) || 'default',
        runtimeType: logRuntimeType(runtime),
        reason: reasonCode(body && typeof body === 'object' ? body : {}, res.statusCode),
        userId: req.user?.id == null ? null : String(req.user.id),
      }));
    }
    return originalJson(body);
  }) as Response['json'];
  next();
};
