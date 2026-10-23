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

const logValue = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  return value.trim().replace(/[^a-zA-Z0-9@/_-]/g, '').slice(0, 120) || null;
};

const reasonCode = (body: RefusalBody, status: number): string => {
  if (typeof body.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(body.code)) return body.code;
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
        agentName: logValue(requestBody.agentName),
        instanceId: logValue(res.locals.agentInstallInstanceId || requestBody.instanceId) || 'default',
        runtimeType: logValue(runtime),
        reason: reasonCode(body && typeof body === 'object' ? body : {}, res.statusCode),
        userId: req.user?.id == null ? null : String(req.user.id),
      }));
    }
    return originalJson(body);
  }) as Response['json'];
  next();
};
