/**
 * The server-owned half of a hosted-MCP tool (TASK-172,
 * `docs/plans/hosted-mcp-connection-scope.md` §3).
 *
 * A catalogue entry is the only source for everything an agent sees and
 * everything a grant is checked against. The vendor's `tools/list` may take a
 * tool away or change what it accepts; it cannot add a tool or parameter to
 * what a seat sees, and it cannot supply the text a seat reads. Entries live
 * in this repo and change only by PR.
 *
 * What this module owns, and what it deliberately does not:
 * - It projects an entry's pins into the entry-owned half of a
 *   `ToolDefinition` — name, description, write mode, `irreversible`, the
 *   pinned `inputSchema`. It does NOT attach `call`: forwarding to the
 *   vendor's `tools/call` needs the row's decrypted credential, which is §4's
 *   intake (build order step 3). `ToolConnection` is still GitHub-shaped, so
 *   attaching `call` here would mean casting a connection type that does not
 *   exist yet.
 * - It assesses each pinned tool against one upstream list. The list is taken
 *   with the row's own credential, because the spec says the list "MAY vary by
 *   the authorization presented on the request" — a list taken with any other
 *   credential proves nothing about this row.
 * - It caches that comparison per row behind a TTL, so the vendor is polled on
 *   a schedule rather than on every `tools/list` or `tools/call`.
 *
 * Drift is a named refusal, never a silent change: a pinned tool absent from
 * this row's list is `tool_unavailable` (or `not_granted`, for a write pin the
 * row never consented to: F102), and one whose schema or annotations
 * moved incompatibly is `tool_drift` until a PR re-pins it. A compatible
 * read-schema change keeps the pin and emits a fresh-assessment signal. Only
 * `tool_drift` reaches an operator (hostedMcpDriftAlertService): absence can
 * be the row's own consent, so it says nothing about the vendor.
 */
import { createHash } from 'crypto';
import type { HostedToolDefinition } from './toolBrokerService';
import type { RoomGrantWriteMode } from '../models/RoomGrant';

/** Read reaches the vendor's APIs; write is offered only where §5's four conditions hold. */
export type HostedMcpToolClass = 'read' | 'write';

/**
 * The vendor's annotations as seen when the tool was pinned. The MCP spec says
 * clients MUST treat annotations as untrusted unless they come from a trusted
 * server, and a vendor's server is not one we run, so these grant nothing: they
 * exist only to detect a vendor moving toward write since the pin.
 */
export interface HostedMcpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface HostedMcpPinnedTool {
  /** The name an agent sees, before the entry namespaces it. */
  name: string;
  /** The name the vendor's server knows. */
  upstreamName: string;
  /** The description an agent reads — ours, never the vendor's. */
  description: string;
  class: HostedMcpToolClass;
  /** Parks a call even on a `write` grant, by the same rule GitHub's tools use. */
  irreversible?: boolean;
  /** The schema the owner approves args under, pinned. */
  inputSchema: Record<string, unknown>;
  annotations?: HostedMcpAnnotations;
  /**
   * Optional properties the vendor offers that our agents never send (F101).
   * The pin keeps them, because it must match the vendor's schema exactly; the
   * model's schema leaves them out, and a call drops any value sent for them.
   * Top-level properties only; a nested field needs its own mechanism.
   */
  withheldArgs?: readonly string[];
}

/** Fields every hosted entry carries, whatever its credential. */
export interface HostedMcpEntryCommon {
  /** Namespaces every tool name (`<id>.<tool>`) and names the row's app. */
  id: string;
  title: string;
  /**
   * The line the Tools page draws under the title. Ours, like a tool's
   * description and for the same reason: the vendor's wording would reach a
   * person's screen and a seat's prompt with no review.
   */
  description?: string;
  /** Setup instruction shown before a member starts this vendor's consent flow. */
  connectNotice?: string;
  /** The MCP tools/call endpoint; also the RFC 8707 resource unless `audience` is set. */
  resource: string;
  /** The PRM resource identifier when it differs from the tools/call endpoint. */
  audience?: string;
  /**
   * Where the authorization dies, naming its kind because the URL cannot (§3).
   * Exactly one key: an `endpoint` is the RFC 7009 revocation endpoint the AS's
   * metadata advertises, a `page` is where a person revokes by hand. Both are
   * https, and only the kind decides whether removal calls the vendor.
   */
  revoke: { page: string; endpoint?: string };
  /**
   * Where a person chooses, at the vendor, what this connection can reach. For
   * GitHub that is the App's install page: its user token reaches only the
   * accounts and repositories the App is installed on. Offered beside Connect
   * and on the connected row, so the reach is the person's own choice; https only.
   */
  accessPage?: string;
  /**
   * D248: whether a fresh connection can reach nothing yet, so the callback
   * sends the person on to `accessPage` instead of back to Commonly (GitHub
   * with no installation of its App). Best effort: false on any doubt.
   */
  needsAccessSetup?: (accessToken: string) => Promise<boolean>;
  /**
   * TASK-782: how much a fresh connection can see, read at the callback.
   * `{ projects: 0 }` only when the probe read everything and found nothing;
   * null on any doubt, so the page never warns on a guess.
   */
  reachProbe?: (accessToken: string) => Promise<{ projects: number } | null>;
  tools: HostedMcpPinnedTool[];
}

/**
 * OAuth entries: every shipped one. The authorization server and the client
 * shape belong to the OAuth flow, so they live only on this member.
 */
export interface HostedMcpOAuthEntry extends HostedMcpEntryCommon {
  credentialMode?: 'oauth';
  /** The authorization server the protected-resource metadata names. */
  issuer: string;
  client: 'pre-registered' | 'cimd' | 'dcr';
  /** Entry-pinned exception when an AS omits its token auth-method list. */
  tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post';
  scopes: string[];
  /** The scope a token needs for this entry's write tools. A connection whose
   * granted scope lacks it cannot be granted write-with-confirm. */
  writeScope?: string;
  /** Only the vendor-specific authorization parameters supported by this code. */
  authorizationParams?: {
    access_type?: string;
    prompt?: string;
  };
}

/**
 * Operator-key entries (TASK-330): a static bearer the operator pastes for one
 * agent. It has no refresh, so `credentialFor` serves it without the freshness
 * rule or the fence. No issuer, client or scopes exist for it, so those fields
 * are absent from this member: reading one off the union is a compile error,
 * which is the census check.
 */
export interface HostedMcpOperatorKeyEntry extends HostedMcpEntryCommon {
  credentialMode: 'operator_key';
}

export type HostedMcpEntry = HostedMcpOAuthEntry | HostedMcpOperatorKeyEntry;

/** One tool as the vendor's `tools/list` reports it. */
export interface HostedMcpUpstreamTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: HostedMcpAnnotations;
}

/**
 * The entry-owned half of a `ToolDefinition`. `call` is absent by construction:
 * it belongs to the intake slice, which is the first slice that has a row whose
 * credential it can decrypt.
 */
export type HostedMcpToolProjection = Omit<HostedToolDefinition, 'call' | 'assess'>;

/**
 * `not_granted` (F102): a write pin this row's list omits because the row's
 * recorded consent lacks the entry's writeScope. It is the row's consent, not
 * the vendor, so it files no drift card and logs no assessment line; a call
 * refuses `write_scope_required`, which tells the owner to reconnect.
 */
export type HostedMcpToolVerdict = 'ok' | 'tool_unavailable' | 'tool_drift' | 'not_granted';

/** What the row consented to, as recorded at connect and narrowed on refresh. */
export interface HostedMcpRowConsent {
  grantedScope?: string | null;
}

/**
 * True when a row's recorded consent includes the entry's writeScope, or the
 * entry names none. Parsed exactly as the grant mint reads it (routes/grants.ts
 * calls this), so the mint's refusal and the assessment cannot disagree: a row
 * with no recorded scope holds none.
 */
export const consentHoldsWriteScope = (entry: HostedMcpEntry, grantedScope: unknown): boolean => {
  const writeScope = 'writeScope' in entry ? entry.writeScope : undefined;
  if (!writeScope) return true;
  return (typeof grantedScope === 'string' ? grantedScope : '').split(/\s+/).includes(writeScope);
};

export interface HostedMcpToolAssessment {
  /** The entry-local name, so a refusal can be read against the pin. */
  name: string;
  /** The name an agent would see, so a trail row names the tool it refused. */
  namespacedName: string;
  verdict: HostedMcpToolVerdict;
  /** Present on a refusal or a compatible read change: our pin-derived reason. */
  detail?: string;
}

/** Namespace an entry's tool so two entries, or an entry and GitHub, cannot collide. */
export const hostedMcpToolName = (entry: HostedMcpEntry, tool: HostedMcpPinnedTool): string =>
  `${entry.id}.${tool.name}`;

/**
 * A write parks unless the grant says `write` — and a hosted-mcp Connection
 * cannot hold a `write` grant, because the mint refuses one (§5). So the class
 * maps to `write-with-confirm` and the park is the same single function every
 * other tool's park is (`toolBrokerService.callTool`).
 */
const writeModeFor = (tool: HostedMcpPinnedTool): RoomGrantWriteMode =>
  (tool.class === 'write' ? 'write-with-confirm' : 'read');

/**
 * Key order is not schema, and a vendor is free to reorder its JSON, so the
 * comparison is over a canonical spelling rather than over `JSON.stringify` of
 * whatever order arrived. Array order IS schema and is preserved.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

/** Bind a parked approval to the entire catalogue pin, including future fields. */
export const digestPinnedDefinition = (entryId: string, tool: HostedMcpPinnedTool): string =>
  createHash('sha256').update(canonicalJson({ entryId, tool })).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const SCHEMA_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_KEYWORDS = new Set([
  'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems',
  'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema',
]);

/**
 * A copy of one schema node with `visit` applied to each child at a JSON
 * Schema position. Values of `default`, `const`, `enum`, and unknown keywords
 * are data or unrecognised shapes, so they are copied untouched for the exact
 * comparison.
 */
const mapSubschemas = (
  schema: Record<string, unknown>,
  visit: (child: unknown) => unknown,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child)]));
    } else if (key === 'dependencies' && isRecord(value)) {
      // Draft-07 dependencies may hold either a subschema or an array of
      // property names. The latter is data and must stay byte-for-byte equal.
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [
        name, isRecord(child) || typeof child === 'boolean' ? visit(child) : child,
      ]));
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      result[key] = value.map(visit);
    } else if (key === 'items') {
      result[key] = Array.isArray(value) ? value.map(visit) : visit(value);
    } else if (SCHEMA_KEYWORDS.has(key)) {
      result[key] = visit(value);
    } else {
      result[key] = value;
    }
  }
  return result;
};

/** `description` is ignorable only at a JSON Schema position. */
const stripSchemaDescriptions = (schema: unknown): unknown => {
  if (!isRecord(schema)) return schema;
  const result = mapSubschemas(schema, stripSchemaDescriptions);
  delete result.description;
  return result;
};

const isTypeName = (value: unknown): boolean => typeof value === 'string';
const typeSet = (names: unknown[]): unknown => {
  const sorted = [...new Set(names as string[])].sort();
  return sorted.length === 1 ? sorted[0] : sorted;
};

/**
 * One nullable type has two spellings that accept exactly the same values: an
 * `anyOf` whose every branch is a bare `{ type }`, and a `type` array (Sentry
 * moved from the first to the second on 11-01). Both become a sorted `type`
 * array, or the one type name, at schema positions only. An `anyOf` beside its
 * own `type`, or with any branch carrying another keyword, is left as written.
 */
const normalizeTypeSpelling = (schema: unknown): unknown => {
  if (!isRecord(schema)) return schema;
  const result = mapSubschemas(schema, normalizeTypeSpelling);
  if (Array.isArray(result.type) && result.type.every(isTypeName)) result.type = typeSet(result.type);
  const branches = result.anyOf;
  if (result.type === undefined && Array.isArray(branches) && branches.length > 0
    && branches.every((branch) => isRecord(branch) && Object.keys(branch).length === 1
      && (isTypeName(branch.type) || (Array.isArray(branch.type) && branch.type.every(isTypeName))))) {
    result.type = typeSet(branches.flatMap((branch) => ([] as unknown[])
      .concat((branch as Record<string, unknown>).type)));
    delete result.anyOf;
  }
  return result;
};

const isNameList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isTypeName);

// Positions where a schema only has to hold for an instance to pass, so
// requiring less there accepts a superset. Under `not`, `if`, `oneOf` and
// `contains` (with its counts), requiring less can admit or refuse other
// calls, so their `required` lists compare exactly, as do those in `$defs`.
// A `$ref` can carry a schema from any position into any other, so the walk
// runs only when every reference stays inside the root `$defs` or
// `definitions` (refsStayInDefs).
const LOOSENING_MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'dependentSchemas', 'dependencies']);
const LOOSENING_ARRAY_KEYWORDS = new Set(['allOf', 'anyOf', 'prefixItems']);
const LOOSENING_KEYWORDS = new Set([
  'additionalProperties', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'then', 'else',
]);

const REFERENCE_KEYWORDS = new Set([
  '$id', '$anchor', '$dynamicAnchor', '$recursiveAnchor', '$dynamicRef', '$recursiveRef',
]);
const DEFS_POINTER = /^#\/(\$defs|definitions)\//;

/**
 * True when no schema can be reached from another position than where it is
 * written, except inside the root `$defs`/`definitions`, which are never
 * relaxed: every `$ref` points there, and nothing declares an id, an anchor or
 * a dynamic reference. Every key is scanned, data included, so a stray `$ref`
 * can only make the comparison exact.
 */
const refsStayInDefs = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.every(refsStayInDefs);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(([key, child]) => {
    if (REFERENCE_KEYWORDS.has(key)) return false;
    if (key === '$ref') return typeof child === 'string' && DEFS_POINTER.test(child);
    return refsStayInDefs(child);
  });
};

/**
 * The pin with each `required` list replaced by the live one wherever the live
 * one only drops names, walking the two schemas together and only through
 * positions where requiring less can only accept more. With references kept
 * inside `$defs` (the caller checks), a call the pin allowed still validates
 * when the vendor requires less there, and no call the pin refused starts to
 * pass except by leaving a property out.
 */
const relaxRequired = (pinned: unknown, current: unknown): unknown => {
  if (!isRecord(pinned) || !isRecord(current)) return pinned;
  const result: Record<string, unknown> = { ...pinned };
  const pinnedRequired = isNameList(pinned.required) ? pinned.required : null;
  if (pinnedRequired && (current.required === undefined
    || (isNameList(current.required) && current.required.every((name) => pinnedRequired.includes(name))))) {
    if (current.required === undefined) delete result.required;
    else result.required = current.required;
  }
  for (const [key, value] of Object.entries(pinned)) {
    const live = current[key];
    if (LOOSENING_MAP_KEYWORDS.has(key) && isRecord(value) && isRecord(live)) {
      // A dependencies entry that is a list of names is data; relaxRequired
      // returns a non-schema unchanged.
      result[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [
        name, Object.prototype.hasOwnProperty.call(live, name) ? relaxRequired(child, live[name]) : child,
      ]));
    } else if ((LOOSENING_ARRAY_KEYWORDS.has(key) || key === 'items') && Array.isArray(value)
      && Array.isArray(live) && live.length === value.length) {
      result[key] = value.map((child, index) => relaxRequired(child, live[index]));
    } else if (key === 'items' || LOOSENING_KEYWORDS.has(key)) {
      result[key] = relaxRequired(value, live);
    }
  }
  return result;
};

const POINTER_KEYWORDS = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

/**
 * True when no reference can name an `anyOf` branch, so sorting and folding
 * the branches (normalizeTypeSpelling) cannot change what a reference resolves
 * to. A folded branch holds only `type`, so no anchor or id can sit on it; a
 * pointer is the only way in. A reference that is not a string, or that names
 * `anyOf` anywhere once percent-decoded, keeps both spellings as written.
 */
const refsAvoidAnyOf = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.every(refsAvoidAnyOf);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(([key, child]) => {
    if (!POINTER_KEYWORDS.has(key)) return refsAvoidAnyOf(child);
    if (typeof child !== 'string') return false;
    try {
      return !decodeURIComponent(child).toLowerCase().includes('anyof');
    } catch {
      return false;
    }
  });
};

/**
 * After descriptions are stripped, a read pin accepts three loosenings: new
 * optional top-level properties, a property leaving `required` at a position
 * where that can only accept more (relaxRequired, when every `$ref` stays in
 * `$defs`), and a nullable type respelled (when no reference names an `anyOf`
 * branch). Values (enum, pattern, default, const) still compare
 * exactly: an added enum value widens what can be read, so it waits until the
 * broker checks argument values against the pin (CTO ruling 11-04, F100).
 */
const readSchemaChange = (
  pin: Record<string, unknown>,
  live: Record<string, unknown> | undefined,
): 'unchanged' | 'compatible' | 'drift' => {
  if (canonicalJson(live ?? null) === canonicalJson(pin)) return 'unchanged';
  const respell = refsAvoidAnyOf(pin) && refsAvoidAnyOf(live ?? null);
  const spell = (schema: unknown): unknown => (respell ? normalizeTypeSpelling(schema) : schema);
  const current = spell(stripSchemaDescriptions(live ?? null));
  const normalizedPin = spell(stripSchemaDescriptions(pin));
  const pinned = refsStayInDefs(pin) && refsStayInDefs(live ?? null)
    ? relaxRequired(normalizedPin, current) : normalizedPin;
  if (canonicalJson(current) === canonicalJson(pinned)) return 'compatible';
  if (!isRecord(pinned) || !isRecord(current)) return 'drift';
  const pinnedProperties = pinned.properties;
  const currentProperties = current.properties;
  if ((pinnedProperties !== undefined && !isRecord(pinnedProperties))
    || !isRecord(currentProperties)) return 'drift';
  const previous = isRecord(pinnedProperties) ? pinnedProperties : {};
  const added = Object.keys(currentProperties)
    .filter((name) => !Object.prototype.hasOwnProperty.call(previous, name));
  if (added.length === 0 || (current.required !== undefined && !Array.isArray(current.required))
    || added.some((name) => (current.required as unknown[] | undefined)?.includes(name))) return 'drift';
  const retained = { ...currentProperties };
  for (const name of added) delete retained[name];
  const withoutAdditions = { ...current };
  if (pinnedProperties === undefined && Object.keys(retained).length === 0) {
    delete withoutAdditions.properties;
  } else {
    withoutAdditions.properties = retained;
  }
  return canonicalJson(withoutAdditions) === canonicalJson(pinned) ? 'compatible' : 'drift';
};

/**
 * Did the vendor's annotations move toward write since the pin? Every arm here
 * reads the annotations the PIN RECORDED, never its class (§3).
 *
 * The spec defaults an absent `readOnlyHint` to `false` and an absent
 * `destructiveHint` to `true` — the unsafe value both times — so a vendor that
 * stops saying `readOnlyHint: true`, or stops saying `destructiveHint: false`,
 * has withdrawn a claim the pin made. A live `destructiveHint: true` also
 * contradicts a recorded `readOnlyHint: true`; the entry load refuses that pair
 * (#2014), and drift does not admit later what entry refuses. A default newly
 * spelled on a pin that recorded neither claim is not drift: there is nothing
 * to withdraw, and a tool gaining `readOnlyHint` still tightens its own claim.
 *
 * The withdrawn-claim arms come first, because a pin that recorded both claims
 * and now meets the contradiction reports the `destructiveHint: false` it lost
 * rather than the generic contradiction.
 */
const movedTowardWrite = (
  pinned: HostedMcpAnnotations,
  live: HostedMcpAnnotations | undefined,
): string | null => {
  if (pinned.readOnlyHint === true && live?.readOnlyHint !== true) return 'readOnlyHint withdrawn upstream';
  if (pinned.destructiveHint === false && live?.destructiveHint !== false) {
    return 'destructiveHint: false withdrawn upstream';
  }
  if (pinned.readOnlyHint === true && live?.destructiveHint === true) return 'destructiveHint set upstream';
  return null;
};

/** The pinned schema as the model sees it: withheld properties left out. */
export const modelInputSchema = (tool: HostedMcpPinnedTool): Record<string, unknown> => {
  const withheld = new Set(tool.withheldArgs || []);
  const properties = tool.inputSchema.properties;
  if (!withheld.size || !properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return tool.inputSchema;
  }
  return {
    ...tool.inputSchema,
    properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !withheld.has(name))),
  };
};

/** The call's arguments with any withheld value dropped. */
export const withoutWithheldArgs = (
  tool: HostedMcpPinnedTool,
  args: Record<string, unknown>,
): Record<string, unknown> => {
  if (!tool.withheldArgs?.length) return args;
  const withheld = new Set(tool.withheldArgs);
  return Object.fromEntries(Object.entries(args).filter(([name]) => !withheld.has(name)));
};

export const entryToolProjections = (entry: HostedMcpEntry): HostedMcpToolProjection[] =>
  entry.tools.map((tool) => ({
    name: hostedMcpToolName(entry, tool),
    description: tool.description,
    requiredWriteMode: writeModeFor(tool),
    connectionType: 'hosted-mcp',
    entryId: entry.id,
    definitionDigest: digestPinnedDefinition(entry.id, tool),
    entryTitle: entry.title,
    irreversible: tool.irreversible,
    inputSchema: modelInputSchema(tool),
  }));

/**
 * Assess every PINNED tool against one upstream list. Upstream tools that are
 * not in the entry are not assessed at all and are never offered: the offered
 * set is the entry's pins, so a vendor adding a tool cannot widen what a seat
 * sees. That is not an error, and this function has no output for it.
 *
 * A duplicate upstream name is resolved first-wins, deterministically. The
 * spec says names are unique within a server, so the shape is not modelled.
 */
export const assessEntryTools = (
  entry: HostedMcpEntry,
  upstream: HostedMcpUpstreamTool[],
  consent?: HostedMcpRowConsent,
): HostedMcpToolAssessment[] => {
  const byUpstreamName = new Map<string, HostedMcpUpstreamTool>();
  for (const tool of upstream) {
    const name = String(tool.name);
    if (!byUpstreamName.has(name)) byUpstreamName.set(name, tool);
  }

  return entry.tools.map((tool) => {
    const namespacedName = hostedMcpToolName(entry, tool);
    const live = byUpstreamName.get(tool.upstreamName);
    // Only a caller that knows the row passes its consent. A listed write is
    // assessed like any pin; only an absent one can be the consent's doing.
    if (!live && tool.class === 'write' && consent && !consentHoldsWriteScope(entry, consent.grantedScope)) {
      const writeScope = 'writeScope' in entry ? entry.writeScope : undefined;
      return {
        name: tool.name,
        namespacedName,
        verdict: 'not_granted' as const,
        detail: `this connection's consent does not include ${writeScope}; reconnect ${entry.title} to enable writes`,
      };
    }
    if (!live) {
      return {
        name: tool.name,
        namespacedName,
        verdict: 'tool_unavailable' as const,
        // Named against this row: a list depends on what its owner consented to
        // (Sentry gates update_issue behind Triage), so absence here is not a
        // vendor removal. "Upstream no longer lists" read as one on 11-01.
        detail: `this connection's tools/list does not include ${tool.upstreamName}`,
      };
    }
    const schemaChange = tool.class === 'read'
      ? readSchemaChange(tool.inputSchema, live.inputSchema)
      : (canonicalJson(live.inputSchema ?? null) === canonicalJson(tool.inputSchema) ? 'unchanged' : 'drift');
    if (schemaChange === 'drift') {
      return {
        name: tool.name,
        namespacedName,
        verdict: 'tool_drift' as const,
        detail: `upstream inputSchema for ${tool.upstreamName} differs from the pin`,
      };
    }
    const moved = movedTowardWrite(tool.annotations ?? {}, live.annotations);
    if (moved) {
      return {
        name: tool.name,
        namespacedName,
        verdict: 'tool_drift' as const,
        detail: moved,
      };
    }
    return {
      name: tool.name,
      namespacedName,
      verdict: 'ok' as const,
      ...(schemaChange === 'compatible'
        ? { detail: `upstream inputSchema for ${tool.upstreamName} changed compatibly; using the pin` }
        : {}),
    };
  });
};

/**
 * Five minutes: long enough that a seat listing tools does not poll the vendor
 * per request, short enough that a vendor's withdrawal is honoured in the same
 * working session. Injectable, because the intake slice measures the real
 * value against the vendor rather than inheriting this default.
 */
export const HOSTED_MCP_DRIFT_TTL_MS = 5 * 60 * 1000;

export interface HostedMcpDriftRow {
  /**
   * The Integration row's `_id`; on a hosted grant this is also installationId.
   * A row belongs to exactly one entry, so its id is also the cache key for
   * the (row, entry) pair. Another member cannot reuse its assessment.
   */
  connectionId: string;
}

export type HostedMcpDriftOutcome =
  | { state: 'assessed'; entryId: string; at: number; cached: boolean; tools: HostedMcpToolAssessment[] }
  | { state: 'provider_unavailable'; entryId: string; detail: string; reason?: string; cause?: unknown };

/** A row's list, with the consent read from the same row the list was taken with. */
export interface HostedMcpUpstreamListing extends HostedMcpRowConsent {
  tools: HostedMcpUpstreamTool[];
}

export interface HostedMcpDriftCacheOptions {
  /**
   * Takes the list with THIS row's credential. Throwing means the vendor could
   * not be reached; the caller must not read that as a clean comparison. A
   * listing that carries the row's consent lets a write pin the row never
   * consented to read as `not_granted`; a bare array assesses without it.
   */
  listUpstreamTools: (row: HostedMcpDriftRow) => Promise<HostedMcpUpstreamTool[] | HostedMcpUpstreamListing>;
  /**
   * Sees each fresh assessment, clean or not; never a cached one or an outage.
   * It runs detached: what it throws is logged and cannot change the outcome.
   */
  onAssessed?: (row: HostedMcpDriftRow, entry: HostedMcpEntry, tools: HostedMcpToolAssessment[]) => unknown;
  ttlMs?: number;
  now?: () => number;
}

export interface HostedMcpDriftCache {
  assess: (row: HostedMcpDriftRow, entry: HostedMcpEntry) => Promise<HostedMcpDriftOutcome>;
  /** Exposed so a removal path can drop one row's entry rather than the whole cache. */
  forget: (row: HostedMcpDriftRow) => void;
}

/**
 * A per-row cache of the drift comparison. The key carries the row, not just
 * the entry: two members of one workspace present different credentials, so a
 * list fetched for one proves nothing about the other.
 *
 * A vendor outage is NOT cached. The cache names it `provider_unavailable`;
 * the caller maps the original transport reason into §9's call trail. A failed
 * fetch must not become a window in which every tool reads as unchanged.
 */
export const createHostedMcpDriftCache = (options: HostedMcpDriftCacheOptions): HostedMcpDriftCache => {
  const ttlMs = options.ttlMs === undefined ? HOSTED_MCP_DRIFT_TTL_MS : options.ttlMs;
  const now = options.now || Date.now;
  const entries = new Map<string, { at: number; tools: HostedMcpToolAssessment[] }>();
  const pending = new Map<string, Set<symbol>>();

  const keyFor = (row: HostedMcpDriftRow) => row.connectionId;

  return {
    forget: (row) => {
      const key = keyFor(row);
      entries.delete(key);
      // Also invalidate a tools/list already in flight under the old grant.
      pending.delete(key);
    },
    assess: async (row, entry) => {
      const key = keyFor(row);
      const cached = entries.get(key);
      const at = now();
      if (cached && at - cached.at < ttlMs) {
        return { state: 'assessed', entryId: entry.id, at: cached.at, cached: true, tools: cached.tools };
      }
      const request = Symbol('hosted-mcp-tools-list');
      const requests = pending.get(key) || new Set<symbol>();
      requests.add(request);
      pending.set(key, requests);
      const finish = () => {
        if (pending.get(key) !== requests) return false;
        requests.delete(request);
        if (requests.size === 0) pending.delete(key);
        return true;
      };
      let listing: HostedMcpUpstreamTool[] | HostedMcpUpstreamListing;
      try {
        listing = await options.listUpstreamTools(row);
      } catch (error) {
        finish();
        // A row whose credential requires reconnect is an authority refusal,
        // not a vendor outage. Preserve it for the broker's refusal trail.
        const code = (error as { code?: unknown })?.code;
        if (code === 'reconnect_required' || code === 'connection_mismatch') throw error;
        const detail = error instanceof Error ? error.message : String(error);
        return {
          state: 'provider_unavailable', entryId: entry.id, detail,
          ...(typeof code === 'string' ? { reason: code } : {}),
          cause: error,
        };
      }
      if (!finish()) {
        return {
          state: 'provider_unavailable', entryId: entry.id,
          detail: 'connection changed during tools/list; retry the call',
          reason: 'provider_error',
        };
      }
      const tools = Array.isArray(listing)
        ? assessEntryTools(entry, listing)
        : assessEntryTools(entry, listing.tools, { grantedScope: listing.grantedScope });
      // A not-granted pin is the row's consent, the same on every assessment,
      // so it is not logged as a change (F102).
      const changed = tools.filter((tool) => tool.verdict !== 'not_granted' && (tool.verdict !== 'ok' || tool.detail));
      if (changed.length > 0) {
        // These names and details come from the pin and our comparison, never
        // from the vendor's live descriptions or schema values.
        console.warn(JSON.stringify({
          event: 'hosted_mcp_tool_assessment',
          entryId: entry.id,
          connectionId: row.connectionId,
          tools: changed,
        }));
      }
      entries.set(key, { at, tools });
      if (options.onAssessed) {
        const { onAssessed } = options;
        Promise.resolve()
          .then(() => onAssessed(row, entry, tools))
          .catch((error) => {
            console.warn(JSON.stringify({
              event: 'hosted_mcp_assessment_hook_failed',
              entryId: entry.id,
              connectionId: row.connectionId,
              reason: error instanceof Error ? error.message : String(error),
            }));
          });
      }
      return { state: 'assessed', entryId: entry.id, at, cached: false, tools };
    },
  };
};

/** True for the OAuth members of the union. The OAuth flow and its readers narrow with this, not a cast. */
export const isOAuthEntry = (entry: HostedMcpEntry): entry is HostedMcpOAuthEntry => (
  entry.credentialMode !== 'operator_key'
);
