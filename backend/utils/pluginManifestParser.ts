import fs from 'fs';
import { isIP } from 'net';
import path from 'path';

import type {
  IComponent,
  IInstallable,
  IMcpSource,
  IMcpVariable,
  InstallableKind,
} from '../models/Installable';

/** A field-level error returned when a plugin cannot be made installable. */
export interface PluginManifestValidationDetail {
  field: string;
  message: string;
}

/**
 * Parsing is deliberately a refusal boundary. In particular, malformed
 * source targets and literal write-only values must fail before a resolver or
 * an adapter gets a chance to read them.
 */
export class PluginManifestValidationError extends Error {
  details: PluginManifestValidationDetail[];

  constructor(details: PluginManifestValidationDetail[]) {
    super(`Invalid plugin manifest: ${details.map(({ field, message }) => `${field}: ${message}`).join('; ')}`);
    this.name = 'PluginManifestValidationError';
    this.details = details;
  }
}

type AnyRecord = Record<string, any>;
type PluginRootKind = 'claude' | 'cursor';

export interface ParsedPluginInstallable {
  installableId: string;
  name: string;
  description: string;
  version: string;
  kind: InstallableKind;
  source: 'marketplace' | 'user';
  scope: IInstallable['scope'];
  requires: string[];
  components: IComponent[];
}

const PLUGIN_DIRS: Array<{ kind: PluginRootKind; directory: string }> = [
  { kind: 'claude', directory: '.claude-plugin' },
  { kind: 'cursor', directory: '.cursor-plugin' },
];

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const URI_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INSTALLABLE_ID_PATTERN = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/;
const VARIABLE_TYPES = new Set(['string', 'number', 'boolean']);
const MAX_STRING_LENGTH = 2_000;
// Keep the parser aligned with the marketplace persistence boundary.
const MAX_COMPONENTS = 50;
const COMMONLY_API_URL_PLACEHOLDER = '${COMMONLY_API_URL}';

const isRecord = (value: unknown): value is AnyRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isOwnerRepoShorthand = (value: string): boolean => {
  if (!OWNER_REPO_PATTERN.test(value)) return false;
  const [owner, repository] = value.split('/');
  return owner !== '.' && owner !== '..' && repository !== '.' && repository !== '..';
};

const hasTraversalSegment = (value: string): boolean => {
  try {
    return decodeURIComponent(value).split('/').includes('..');
  } catch {
    return true;
  }
};

const own = (value: AnyRecord, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
);

const addError = (
  details: PluginManifestValidationDetail[],
  field: string,
  message: string,
) => details.push({ field, message });

const requiredString = (
  value: unknown,
  field: string,
  details: PluginManifestValidationDetail[],
  maxLength = MAX_STRING_LENGTH,
): string => {
  if (typeof value !== 'string' || !value.trim()) {
    addError(details, field, 'Must be a non-empty string');
    return '';
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    addError(details, field, `Must not exceed ${maxLength} characters`);
    return normalized.slice(0, maxLength);
  }
  return normalized;
};

const optionalString = (
  value: unknown,
  field: string,
  details: PluginManifestValidationDetail[],
  maxLength = MAX_STRING_LENGTH,
): string | undefined => {
  if (value === undefined) return undefined;
  return requiredString(value, field, details, maxLength);
};

const normalizeId = (
  name: string,
  details: PluginManifestValidationDetail[],
): string => {
  const trimmed = name.trim();
  const candidate = trimmed
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9@/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '')
    .toLowerCase();
  if (!candidate || !INSTALLABLE_ID_PATTERN.test(candidate)) {
    addError(details, 'manifest.name', 'Must produce a valid installable id');
    return '';
  }
  return candidate;
};

const normalizeRelativeSubpath = (
  value: unknown,
  field: string,
  details: PluginManifestValidationDetail[],
): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    addError(details, field, 'Must be a relative checkout path');
    return undefined;
  }
  const raw = value.trim();
  if (raw.includes('%')) {
    addError(details, field, 'Must not contain percent-encoded path segments');
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    addError(details, field, 'Must be valid URL/path encoding');
    return undefined;
  }
  // Treat backslashes as separators for validation even on POSIX. Otherwise
  // a manifest authored on Windows could smuggle a traversal into a Linux
  // install or vice versa.
  if (
    decoded.includes('\\')
    || decoded.includes('\0')
    || path.posix.isAbsolute(decoded)
    || path.win32.isAbsolute(decoded)
  ) {
    addError(details, field, 'Must be a relative path inside the checkout');
    return undefined;
  }
  const segments = decoded.split('/');
  if (segments.includes('..')) {
    addError(details, field, 'Must not contain .. path segments');
    return undefined;
  }
  const normalized = path.posix.normalize(decoded).replace(/^\.\//, '');
  if (normalized === '.' || normalized === '') return undefined;
  if (normalized === '..' || normalized.startsWith('../')) {
    addError(details, field, 'Must stay inside the checkout');
    return undefined;
  }
  return normalized;
};

const normalizeSource = (
  value: unknown,
  field: string,
  details: PluginManifestValidationDetail[],
): IMcpSource | undefined => {
  let spec: unknown = value;
  let subpath: unknown;
  let pin: unknown;

  if (isRecord(value)) {
    spec = value.spec;
    subpath = value.subpath;
    pin = value.pin;
  }

  if (typeof spec !== 'string' || !spec.trim()) {
    addError(details, `${field}.spec`, 'Must be a non-empty source specification');
    return undefined;
  }
  const normalizedSpec = spec.trim();
  let canonicalSpec = normalizedSpec;

  if (URI_SCHEME_PATTERN.test(normalizedSpec)) {
    let parsed: URL;
    try {
      parsed = new URL(normalizedSpec);
    } catch {
      addError(details, `${field}.spec`, 'Must be a valid source URL');
      return undefined;
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.hostname.toLowerCase() !== 'github.com'
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
    ) {
      addError(details, `${field}.spec`, 'Only https://github.com source URLs are allowed');
      return undefined;
    }
    const repositoryPath = parsed.pathname.replace(/^\//, '').replace(/\/$/, '');
    if (!/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?$/.test(repositoryPath)) {
      addError(details, `${field}.spec`, 'GitHub source URL must identify exactly one repository');
      return undefined;
    }
    canonicalSpec = `https://github.com/${repositoryPath}`;
  } else if (normalizedSpec.includes(':')) {
    // A colon that was not parsed as an allowed URL is generally a URI scheme
    // (file:, ssh:, git:, etc.), not a local path we should interpret.
    addError(details, `${field}.spec`, 'Only https://github.com source URLs or local paths are allowed');
    return undefined;
  } else if (
    !isOwnerRepoShorthand(normalizedSpec)
    && (
      path.posix.isAbsolute(normalizedSpec)
      || path.win32.isAbsolute(normalizedSpec)
      || normalizedSpec.includes('\\')
      || normalizedSpec.split('/').includes('..')
      || hasTraversalSegment(normalizedSpec)
      || normalizedSpec.includes('\0')
    )
  ) {
    // GitHub owner/repo shorthand is already a valid source. Every other
    // scheme-free value is a local path and must remain relative to the root.
    addError(details, `${field}.spec`, 'Local source must be a relative path inside the checkout');
    return undefined;
  } else if (isOwnerRepoShorthand(normalizedSpec)) {
    canonicalSpec = `https://github.com/${normalizedSpec}`;
  } else {
    const normalizedPath = path.posix.normalize(normalizedSpec).replace(/^\.\//, '');
    canonicalSpec = `./${normalizedPath}`;
  }

  const normalizedSubpath = normalizeRelativeSubpath(subpath, `${field}.subpath`, details);
  if (pin !== undefined && (typeof pin !== 'string' || !SHA_PATTERN.test(pin))) {
    addError(details, `${field}.pin`, 'Must be a 40-character commit SHA');
  }

  return {
    spec: canonicalSpec,
    ...(normalizedSubpath ? { subpath: normalizedSubpath } : {}),
    ...(pin !== undefined && typeof pin === 'string' && SHA_PATTERN.test(pin) ? { pin } : {}),
  };
};

const normalizeStringList = (
  value: unknown,
  field: string,
  details: PluginManifestValidationDetail[],
  maxItems = 100,
): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addError(details, field, 'Must be an array of strings');
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      addError(details, `${field}[${index}]`, 'Must be a non-empty string');
      return;
    }
    const normalized = entry.trim();
    if (normalized.length > MAX_STRING_LENGTH) {
      addError(details, `${field}[${index}]`, `Must not exceed ${MAX_STRING_LENGTH} characters`);
      return;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  });
  if (value.length > maxItems) addError(details, field, `Must not contain more than ${maxItems} entries`);
  return result;
};

const normalizeArgvList = (
  value: unknown,
  field: string,
  details: PluginManifestValidationDetail[],
  maxItems = 100,
): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addError(details, field, 'Must be an array of strings');
    return undefined;
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      addError(details, `${field}[${index}]`, 'Must be a non-empty string');
      return;
    }
    const normalized = entry.trim();
    if (normalized.length > MAX_STRING_LENGTH) {
      addError(details, `${field}[${index}]`, `Must not exceed ${MAX_STRING_LENGTH} characters`);
      return;
    }
    result.push(normalized);
  });
  if (value.length > maxItems) addError(details, field, `Must not contain more than ${maxItems} entries`);
  return result;
};

const normalizeDefault = (
  value: unknown,
  field: string,
  type: string,
  details: PluginManifestValidationDetail[],
): string | number | boolean | undefined => {
  if (type === 'string') {
    if (typeof value !== 'string') {
      addError(details, field, 'Must match variable type string');
      return undefined;
    }
    return value;
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      addError(details, field, 'Must match variable type number');
      return undefined;
    }
    return value;
  }
  if (typeof value !== 'boolean') {
    addError(details, field, 'Must match variable type boolean');
    return undefined;
  }
  return value;
};

const normalizeVariables = (
  value: unknown,
  field: string,
  details: PluginManifestValidationDetail[],
): Record<string, IMcpVariable> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addError(details, field, 'Must be an object keyed by variable name');
    return undefined;
  }

  const variables: Record<string, IMcpVariable> = {};
  Object.entries(value).forEach(([name, definition]) => {
    const variableField = `${field}.${name}`;
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name)) {
      addError(details, variableField, 'Variable name is invalid');
      return;
    }
    if (!isRecord(definition)) {
      addError(details, variableField, 'Must be a JSON Schema variable object');
      return;
    }
    const type = requiredString(definition.type, `${variableField}.type`, details, 20);
    if (!VARIABLE_TYPES.has(type)) {
      addError(details, `${variableField}.type`, 'Must be string, number, or boolean');
      return;
    }
    const writeOnly = definition.writeOnly;
    if (writeOnly !== undefined && typeof writeOnly !== 'boolean') {
      addError(details, `${variableField}.writeOnly`, 'Must be a boolean');
    }
    if (writeOnly === true && own(definition, 'default')) {
      addError(details, variableField, 'writeOnly variables cannot contain a literal default');
    }
    if (writeOnly === true) {
      ['value', 'literal', 'secret', 'example', 'examples', 'enum', 'const'].forEach((literalKey) => {
        if (own(definition, literalKey)) {
          addError(details, variableField, `writeOnly variables cannot contain literal ${literalKey}`);
        }
      });
    }
    const description = optionalString(definition.description, `${variableField}.description`, details);
    let defaultValue: string | number | boolean | undefined;
    if (own(definition, 'default') && writeOnly !== true) {
      defaultValue = normalizeDefault(definition.default, `${variableField}.default`, type, details);
    }

    let enumValues: Array<string | number> | undefined;
    if (definition.enum !== undefined) {
      if (!Array.isArray(definition.enum)) {
        addError(details, `${variableField}.enum`, 'Must be an array of strings or numbers');
      } else {
        enumValues = [];
        definition.enum.forEach((entry: unknown, index: number) => {
          const invalidType = typeof entry !== 'string' && typeof entry !== 'number';
          const invalidNumber = typeof entry === 'number' && !Number.isFinite(entry);
          if (invalidType || invalidNumber) {
            addError(details, `${variableField}.enum[${index}]`, 'Must be a string or number');
          } else if (!enumValues!.includes(entry)) {
            enumValues!.push(entry);
          }
        });
      }
    }

    variables[name] = {
      type: type as IMcpVariable['type'],
      ...(description ? { description } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(enumValues ? { enum: enumValues } : {}),
      ...(writeOnly === true ? { writeOnly: true } : {}),
    };
  });
  return variables;
};

const rejectLiteralSecretValues = (
  server: AnyRecord,
  variables: Record<string, IMcpVariable> | undefined,
  field: string,
  details: PluginManifestValidationDetail[],
) => {
  if (!variables) return;
  const env = server.env ?? server.values ?? server.config;
  if (!isRecord(env)) return;
  Object.entries(variables).forEach(([name, definition]) => {
    if (!definition.writeOnly || !own(env, name)) return;
    const value = env[name];
    const isSecretReference = isRecord(value)
      && typeof value.secretRef === 'string'
      && value.secretRef.trim().length > 0;
    const isPlaceholder = typeof value === 'string' && /^\$\{COMMONLY_[A-Z0-9_.-]+\}$/.test(value);
    if (!isSecretReference && !isPlaceholder) {
      addError(details, `${field}.${name}`, 'writeOnly variable must use a secret reference, not a literal');
    }
  });
};

const normalizeHttpUrl = (
  value: unknown,
  field: string,
  details: PluginManifestValidationDetail[],
): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) {
    addError(details, field, 'http server url is required');
    return undefined;
  }
  const url = value.trim();
  if (url.includes('${')) {
    // The runtime may substitute its own origin, but only when the complete
    // origin is the placeholder. `${COMMONLY_API_URL}@evil.com` must never
    // become an authority-bearing URL after substitution.
    if (url.startsWith(COMMONLY_API_URL_PLACEHOLDER)
      && (url.length === COMMONLY_API_URL_PLACEHOLDER.length
        || url[COMMONLY_API_URL_PLACEHOLDER.length] === '/')) {
      return url;
    }
    addError(details, field, 'URL placeholders must stand for the complete origin');
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    addError(details, field, 'Must be a valid https URL');
    return undefined;
  }
  if (parsed.protocol !== 'https:') {
    addError(details, field, 'MCP server URL must use https');
    return undefined;
  }
  if (parsed.username || parsed.password) {
    addError(details, field, 'MCP server URL must not contain credentials');
    return undefined;
  }
  const hostname = parsed.hostname.toLowerCase();
  const hostnameWithoutTrailingDot = hostname.replace(/\.+$/, '');
  const ipCandidate = hostnameWithoutTrailingDot.replace(/^\[|\]$/g, '');
  if (
    hostname.startsWith('[')
    || isIP(ipCandidate) !== 0
    || hostnameWithoutTrailingDot === 'localhost'
    || hostnameWithoutTrailingDot.endsWith('.localhost')
    || hostnameWithoutTrailingDot.endsWith('.local')
    || hostnameWithoutTrailingDot.endsWith('.internal')
  ) {
    addError(details, field, 'MCP server URL host must be a public DNS name');
    return undefined;
  }
  return url;
};

const mergeMissing = (primary: unknown, secondary: unknown): unknown => {
  if (primary === undefined) return secondary;
  if (isRecord(primary) && isRecord(secondary)) {
    const result: AnyRecord = { ...primary };
    Object.entries(secondary).forEach(([key, value]) => {
      result[key] = mergeMissing(result[key], value);
    });
    return result;
  }
  if (Array.isArray(primary) && Array.isArray(secondary)) {
    // Arrays of named records are the one mergeable list shape: Claude keeps
    // authority for duplicate names while Cursor can add a named entry that
    // Claude omitted. Primitive arrays (enabledTools, argv, etc.) are kept
    // wholesale so a secondary provider cannot widen or alter them.
    const isNamedRecord = (entry: unknown): entry is AnyRecord => (
      isRecord(entry) && typeof entry.name === 'string' && Boolean(entry.name.trim())
    );
    const canMergeByName = (entries: unknown[]) => entries.every(isNamedRecord);
    if (canMergeByName(primary) && canMergeByName(secondary)) {
      const result = primary.map((entry) => ({ ...entry }));
      const indexes = new Map(result.map((entry, index) => [entry.name, index]));
      secondary.forEach((entry) => {
        const existingIndex = indexes.get(entry.name);
        if (existingIndex === undefined) {
          indexes.set(entry.name, result.length);
          result.push({ ...entry });
        } else {
          result[existingIndex] = mergeMissing(result[existingIndex], entry) as AnyRecord;
        }
      });
      return result;
    }
    // A defined Claude array is authoritative for every other array shape.
    return primary;
  }
  return primary;
};

const readJson = (
  filePath: string,
  field: string,
  details: PluginManifestValidationDetail[],
): AnyRecord | undefined => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      addError(details, field, 'Must contain a JSON object');
      return undefined;
    }
    return parsed;
  } catch {
    addError(details, field, 'Must be valid JSON');
    return undefined;
  }
};

const safeRelativePath = (
  rootPath: string,
  candidate: string,
  field: string,
  details: PluginManifestValidationDetail[],
): string | undefined => {
  const rootReal = fs.realpathSync(rootPath);
  const target = path.resolve(rootPath, candidate);
  const targetRelative = path.relative(rootPath, target);
  if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
    addError(details, field, 'Path must stay inside the plugin root');
    return undefined;
  }
  try {
    const targetReal = fs.realpathSync(target);
    const relativeReal = path.relative(rootReal, targetReal);
    if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) {
      addError(details, field, 'Path must stay inside the plugin root');
      return undefined;
    }
  } catch {
    addError(details, field, 'Path does not exist inside the plugin root');
    return undefined;
  }
  return target;
};

const normalizeSkill = (
  rootPath: string,
  rawSkill: unknown,
  index: number,
  details: PluginManifestValidationDetail[],
): IComponent | undefined => {
  const field = `manifest.skills[${index}]`;
  const definition = typeof rawSkill === 'string' ? { path: rawSkill } : rawSkill;
  if (!isRecord(definition)) {
    addError(details, field, 'Must be a skill path or object');
    return undefined;
  }
  const skillPath = typeof definition.path === 'string' ? definition.path : undefined;
  const safePath = skillPath ? normalizeRelativeSubpath(skillPath, `${field}.path`, details) : undefined;
  let prompt = optionalString(
    definition.prompt ?? definition.skillPrompt ?? definition.content,
    `${field}.prompt`,
    details,
    100_000,
  );
  if (safePath) {
    const skillDirectory = safeRelativePath(rootPath, safePath, `${field}.path`, details);
    if (skillDirectory && fs.statSync(skillDirectory).isDirectory()) {
      const skillFile = path.join(skillDirectory, 'SKILL.md');
      if (fs.existsSync(skillFile) && prompt === undefined) {
        const safeSkillFile = safeRelativePath(
          rootPath,
          path.join(safePath, 'SKILL.md'),
          `${field}.path`,
          details,
        );
        if (safeSkillFile) prompt = fs.readFileSync(safeSkillFile, 'utf8');
      }
    } else if (skillDirectory && fs.statSync(skillDirectory).isFile() && prompt === undefined) {
      prompt = fs.readFileSync(skillDirectory, 'utf8');
    }
  }
  const name = requiredString(
    definition.name ?? (safePath ? path.basename(safePath) : undefined),
    `${field}.name`,
    details,
    200,
  );
  const skillId = normalizeId(name, details);
  const tools = normalizeStringList(definition.tools ?? definition.skillTools, `${field}.tools`, details);
  const description = optionalString(definition.description, `${field}.description`, details, 2_000);
  const skillPrompt = requiredString(prompt, `${field}.prompt`, details, 100_000);
  const examples = definition.examples ?? definition.skillExamples;
  return {
    name: skillId || name,
    type: 'skill',
    ...(description ? { description } : {}),
    skillId: skillId || name,
    skillPrompt,
    ...(tools ? { skillTools: tools } : {}),
    ...(examples !== undefined ? { skillExamples: examples } : {}),
  };
};

const normalizeCommand = (
  value: unknown,
  args: unknown,
  field: string,
  details: PluginManifestValidationDetail[],
): string[] | undefined => {
  if (Array.isArray(value)) {
    const command = normalizeArgvList(value, field, details, 100);
    if (command && command.length === 0) addError(details, field, 'Must contain at least one argv entry');
    if (args !== undefined) {
      addError(details, `${field}.args`, 'args is not valid when command is already an argv array');
    }
    return command;
  }
  // The public component shape is argv[], but accepting the common manifest
  // `{ command: "npx", args: [...] }` form makes the parser interoperable
  // without leaking that provider-specific shape into Installable.
  if (typeof value === 'string' && value.trim()) {
    const normalizedCommand = requiredString(value, field, details, 2_000);
    if (args === undefined) return [normalizedCommand];
    const normalizedArgs = normalizeArgvList(args, `${field}.args`, details, 99);
    return normalizedArgs ? [normalizedCommand, ...normalizedArgs] : [normalizedCommand];
  }
  addError(details, field, 'stdio server command must be an argv array');
  return undefined;
};

const normalizeMcpServer = (
  serverName: string,
  server: unknown,
  manifest: AnyRecord,
  index: number,
  details: PluginManifestValidationDetail[],
  fieldPrefix = 'manifest.mcpServers',
): IComponent | undefined => {
  const field = fieldPrefix === 'manifest.mcpServers'
    ? `${fieldPrefix}.${serverName || index}`
    : fieldPrefix;
  if (!isRecord(server)) {
    addError(details, field, 'Must be an object');
    return undefined;
  }
  const name = requiredString(server.name ?? serverName, `${field}.name`, details, 200);
  const transport = server.transport
    ?? (server.command !== undefined ? 'stdio' : server.url !== undefined ? 'http' : undefined);
  if (transport !== 'stdio' && transport !== 'http') {
    addError(details, `${field}.transport`, 'Must be stdio or http');
  }
  const sourceValue = server.source !== undefined ? server.source : manifest.source;
  const sourceInput = isRecord(sourceValue)
    ? {
      ...sourceValue,
      subpath: sourceValue.subpath ?? server.subpath ?? manifest.subpath,
      pin: sourceValue.pin ?? server.pin ?? manifest.pin,
    }
    : {
      spec: sourceValue,
      subpath: server.subpath ?? manifest.subpath,
      pin: server.pin ?? manifest.pin,
    };
  const source = normalizeSource(sourceInput, `${field}.source`, details);
  const variables = normalizeVariables(
    server.variables !== undefined ? server.variables : manifest.variables,
    `${field}.variables`,
    details,
  );
  rejectLiteralSecretValues(server, variables, `${field}.env`, details);
  const enabledTools = normalizeStringList(
    server.enabledTools !== undefined ? server.enabledTools : manifest.enabledTools,
    `${field}.enabledTools`,
    details,
  );

  let command: string[] | undefined;
  if (transport === 'stdio') {
    command = normalizeCommand(server.command, server.args, `${field}.command`, details);
    if (server.url !== undefined) addError(details, `${field}.url`, 'stdio servers must not define url');
  } else if (transport === 'http') {
    if (server.command !== undefined || server.args !== undefined) {
      addError(details, `${field}.command`, 'http servers must not define command');
    }
    normalizeHttpUrl(server.url, `${field}.url`, details);
  }

  return {
    name,
    type: 'mcp-server',
    transport: transport as 'stdio' | 'http',
    ...(source ? { source } : {}),
    ...(command ? { command } : {}),
    ...(transport === 'http' && typeof server.url === 'string' ? { url: server.url.trim() } : {}),
    ...(variables ? { variables } : {}),
    ...(enabledTools ? { enabledTools } : {}),
    ...(typeof server.description === 'string' && server.description.trim()
      ? { description: server.description.trim() }
      : {}),
  };
};

const normalizeMcpServers = (
  value: unknown,
  manifest: AnyRecord,
  details: PluginManifestValidationDetail[],
): IComponent[] => {
  if (value === undefined) return [];
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((entry) => [isRecord(entry) && typeof entry.name === 'string' ? entry.name : '', entry])
    : isRecord(value) ? Object.entries(value) : [];
  if (!Array.isArray(value) && !isRecord(value)) {
    addError(details, 'manifest.mcpServers', 'Must be an object or array');
    return [];
  }
  if (entries.length > MAX_COMPONENTS) {
    addError(details, 'manifest.mcpServers', `Must not contain more than ${MAX_COMPONENTS} entries`);
  }
  return entries
    .slice(0, MAX_COMPONENTS)
    .map(([name, server], index) => normalizeMcpServer(name, server, manifest, index, details))
    .filter((component): component is IComponent => component !== undefined);
};

/** Validate one already-decoded MCP component at an API persistence boundary. */
export const validateMcpComponent = (
  component: unknown,
  fieldPrefix = 'component',
): { component?: IComponent; errors: PluginManifestValidationDetail[] } => {
  const details: PluginManifestValidationDetail[] = [];
  const normalized = normalizeMcpServer('', component, {}, 0, details, fieldPrefix);
  return { component: normalized, errors: details };
};

const readPluginManifests = (
  rootPath: string,
  details: PluginManifestValidationDetail[],
): { manifest: AnyRecord; kinds: PluginRootKind[] } => {
  const manifests: Array<{ kind: PluginRootKind; manifest: AnyRecord }> = [];
  PLUGIN_DIRS.forEach(({ kind, directory }) => {
    const relativeManifestPath = path.join(directory, 'plugin.json');
    const manifestPath = path.join(rootPath, relativeManifestPath);
    if (!fs.existsSync(manifestPath)) return;
    const safeManifestPath = safeRelativePath(
      rootPath,
      relativeManifestPath,
      `${directory}/plugin.json`,
      details,
    );
    if (!safeManifestPath) return;
    const parsed = readJson(safeManifestPath, `${directory}/plugin.json`, details);
    if (parsed) manifests.push({ kind, manifest: parsed });
  });
  if (!manifests.length) {
    addError(details, 'root', 'Expected .claude-plugin/plugin.json or .cursor-plugin/plugin.json');
    return { manifest: {}, kinds: [] };
  }
  const primary = manifests.find(({ kind }) => kind === 'claude') ?? manifests[0];
  const secondary = manifests.find(({ kind }) => kind !== primary.kind);
  return {
    manifest: secondary ? mergeMissing(primary.manifest, secondary.manifest) as AnyRecord : primary.manifest,
    kinds: manifests.map(({ kind }) => kind),
  };
};

/**
 * Parse a local Claude/Cursor plugin root into an Installable-shaped object.
 * This first cut never fetches a source; it only validates source metadata and
 * reads files below the supplied local root.
 */
export const parsePluginManifest = (
  root: string,
  options: { source?: 'marketplace' | 'user'; scope?: IInstallable['scope'] } = {},
): ParsedPluginInstallable => {
  const details: PluginManifestValidationDetail[] = [];
  if (typeof root !== 'string' || !root.trim()) {
    throw new PluginManifestValidationError([{ field: 'root', message: 'Plugin root is required' }]);
  }
  let rootPath: string;
  try {
    rootPath = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(rootPath).isDirectory()) throw new Error('not directory');
  } catch {
    throw new PluginManifestValidationError([{ field: 'root', message: 'Plugin root must be an existing directory' }]);
  }

  const loaded = readPluginManifests(rootPath, details);
  const manifest = loaded.manifest;
  const name = requiredString(manifest.name, 'manifest.name', details, 200);
  const installableId = normalizeId(name, details);
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : '';
  const version = requiredString(manifest.version, 'manifest.version', details, 100);

  const components = normalizeMcpServers(manifest.mcpServers, manifest, details);
  const rawSkills = manifest.skills;
  if (rawSkills !== undefined) {
    if (!Array.isArray(rawSkills)) {
      addError(details, 'manifest.skills', 'Must be an array');
    } else {
      rawSkills.slice(0, MAX_COMPONENTS - components.length).forEach((skill, index) => {
        const component = normalizeSkill(rootPath, skill, index, details);
        if (component) components.push(component);
      });
      if (rawSkills.length > MAX_COMPONENTS) {
        addError(details, 'manifest.skills', `Must not contain more than ${MAX_COMPONENTS} entries`);
      }
    }
  }
  if (components.length > MAX_COMPONENTS) {
    addError(details, 'manifest.components', `Must not contain more than ${MAX_COMPONENTS} entries`);
  }
  if (details.length) throw new PluginManifestValidationError(details);

  const kind: InstallableKind = components.length > 0 && components.every(({ type }) => type === 'skill')
    ? 'skill'
    : 'app';
  return {
    installableId,
    name,
    description,
    version,
    kind,
    source: options.source ?? 'user',
    scope: options.scope ?? 'user',
    requires: [],
    components,
  };
};

// Names used by callers that describe the input as a root rather than a file.
export const parsePluginRoot = parsePluginManifest;
export const parsePluginInstallable = parsePluginManifest;

export default parsePluginManifest;
