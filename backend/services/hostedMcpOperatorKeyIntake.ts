import type { HostedMcpEntry, HostedMcpUpstreamTool } from './hostedMcpEntryService';
import { listHostedMcpTools } from './hostedMcpToolDefinitions';

/**
 * Scopes an operator key may never carry (TASK-330 Decision 2). A key with any
 * of them could approve its own jobs, rotate secrets or apply migrations, which
 * is more authority than a seat should hold through a connector.
 */
export const OPERATOR_KEY_REFUSED_SCOPES = ['secrets:write', 'jobs:approve', 'migration:apply'] as const;

export const refusedOperatorKeyScopes = (scopes: readonly string[]): string[] => (
  scopes.filter((scope) => (OPERATOR_KEY_REFUSED_SCOPES as readonly string[]).includes(scope))
);

export type OperatorKeyIntakeRefusal =
  | { ok: false; code: 'not_operator_key' | 'key_missing' | 'scope_refused' | 'vendor_rejected' | 'vendor_unreachable'; message: string };

export type OperatorKeyIntakeResult =
  | { ok: true; tools: HostedMcpUpstreamTool[]; scopeCheck: 'read' | 'self_report' }
  | OperatorKeyIntakeRefusal;

export interface OperatorKeyIntakeInput {
  entry: HostedMcpEntry;
  /** The pasted key. It is used for the probe and never returned, logged or echoed. */
  key: string;
  /**
   * The scopes Latchkey reports for this key, or null when it cannot report
   * them. Null means the check is a self-report, which the caller must surface
   * as such: a refused scope is then not a server guarantee (Vera §4).
   */
  reportedScopes: readonly string[] | null;
  fetcher: typeof fetch;
  listTools?: typeof listHostedMcpTools;
}

/**
 * Prove a pasted key before its row can go `connected` (TASK-330, Vera §5).
 *
 * The probe is the same tools/list client the broker uses for calls, so a key
 * that passes here is one the calls can use. Every refusal carries fixed copy:
 * the vendor's own text and the key never leave this function, so a caller
 * cannot relay the secret by mistake.
 */
export const validateOperatorKey = async (
  input: OperatorKeyIntakeInput,
): Promise<OperatorKeyIntakeResult> => {
  const { entry, key } = input;
  if (entry.credentialMode !== 'operator_key') {
    return { ok: false, code: 'not_operator_key', message: 'this connector does not take a pasted key' };
  }
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed) {
    return { ok: false, code: 'key_missing', message: 'paste the key to continue' };
  }
  const refused = input.reportedScopes ? refusedOperatorKeyScopes(input.reportedScopes) : [];
  if (refused.length > 0) {
    return {
      ok: false,
      code: 'scope_refused',
      message: `this key carries ${refused.join(', ')}; create a key without those scopes`,
    };
  }
  const listTools = input.listTools ?? listHostedMcpTools;
  try {
    const tools = await listTools(entry, trimmed, input.fetcher);
    return { ok: true, tools, scopeCheck: input.reportedScopes ? 'read' : 'self_report' };
  } catch (error) {
    const status = (error as { code?: string })?.code;
    if (status === 'credential_rejected') {
      return { ok: false, code: 'vendor_rejected', message: 'the vendor rejected this key' };
    }
    return { ok: false, code: 'vendor_unreachable', message: 'the vendor could not be reached to check this key' };
  }
};
