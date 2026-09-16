// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Installable = require('../../models/Installable');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const InstallableInstallation = require('../../models/InstallableInstallation');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { toPublicIntegration, withoutConnectCode } = require('../../models/integrationPublicConfig');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { manifests } = require('../../integrations/manifests');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { TOOL_INSTALLABLES, mcpComponentOf, projectTools } = require('./toolInstallables');

type ProviderReadiness = { available: boolean; reason?: 'not_configured' };

type ProviderManifest = {
  id: string;
  readiness?: () => ProviderReadiness;
};

type LocalizedInstallable = {
  description?: unknown;
  descriptions?: unknown;
  source?: string;
};

/**
 * Return the most specific locale in a browser Accept-Language value. The
 * catalog only translates first-party builtins; every other source keeps its
 * canonical description even when it happens to carry a locale map.
 */
const localeCandidates = (locale?: string): string[] => {
  const raw = typeof locale === 'string' ? locale : '';
  const candidates: string[] = [];
  raw.split(',').forEach((part) => {
    const token = part.trim().split(';', 1)[0]?.trim();
    if (!token) return;
    const normalized = token.replace(/_/g, '-');
    const [language, region, ...rest] = normalized.split('-');
    if (!language) return;
    const canonical = [language.toLowerCase(), region?.toUpperCase(), ...rest].filter(Boolean).join('-');
    if (canonical && !candidates.includes(canonical)) candidates.push(canonical);
    const base = language.toLowerCase();
    if (!candidates.includes(base)) candidates.push(base);
  });
  if (!candidates.includes('en')) candidates.push('en');
  return candidates;
};

const localizedDescription = (installable: LocalizedInstallable | null | undefined, locale?: string): string => {
  const canonical = typeof installable?.description === 'string' ? installable.description : '';
  if (installable?.source && installable.source !== 'builtin') return canonical;

  const descriptions = installable?.descriptions;
  if (!descriptions || typeof descriptions !== 'object' || Array.isArray(descriptions)) return canonical;
  const read = (key: string): unknown => (
    descriptions instanceof Map
      ? descriptions.get(key)
      : (descriptions as Record<string, unknown>)[key]
  );
  for (const candidate of localeCandidates(locale)) {
    const value = read(candidate);
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return canonical;
};

const providerInstallableIds = (): string[] => Object.values(manifests as Record<string, ProviderManifest>)
  .filter((manifest) => typeof manifest.readiness === 'function')
  .map((manifest) => manifest.id);

// Only manifests opt into installable readiness. Unknown Installables continue
// to their service-level not-found handling instead of becoming config errors.
const providerReadiness = (installableId: string): ProviderReadiness | null => {
  const manifest = (manifests as Record<string, ProviderManifest>)[installableId];
  return typeof manifest?.readiness === 'function' ? manifest.readiness() : null;
};

// Mongoose's Integration toJSON transform is the normal guard. Lean catalog
// reads bypass it, so they run the same strip explicitly: one key list, so a
// credential can never be serialized here that toJSON would have dropped.
const publicIntegration = (integration: unknown): unknown => {
  if (!integration || typeof integration !== 'object') return integration;
  const raw = typeof (integration as { toJSON?: () => unknown }).toJSON === 'function'
    ? (integration as { toJSON: () => unknown }).toJSON()
    : JSON.parse(JSON.stringify(integration));
  if (!raw || typeof raw !== 'object') return raw;
  const result = toPublicIntegration(raw as Record<string, unknown>);
  // A Slack row's connect code is its OAuth state. The catalog has no reader
  // for it; the Connectors page polls on it from the owner's list.
  return result?.type === 'slack' ? withoutConnectCode(result) : result;
};

// The parent has operational fields that are useful to the owner's state
// machine, and several identity/claim fields that are not. Keep this mapper
// explicit so a future parent field cannot become API data by accident.
const publicInstallation = (installation: any): unknown => {
  if (!installation || typeof installation !== 'object') return null;
  const components = Array.isArray(installation.components) ? installation.components.map((component: any) => ({
    name: component.componentName,
    status: component.status,
    ...(component.errorMessage ? { errorMessage: component.errorMessage } : {}),
  })) : [];
  return {
    status: installation.status,
    ...(installation.errorMessage ? { errorMessage: installation.errorMessage } : {}),
    ...(installation.boundPodId ? { boundPodId: String(installation.boundPodId) } : {}),
    ...(installation.claimedAt ? { claimedAt: installation.claimedAt } : {}),
    ...(installation.updatedAt ? { updatedAt: installation.updatedAt } : {}),
    components,
  };
};

// A Connection the caller may grant from: the mint requires the connection's
// owner, so only the caller's own rows are offered. `connectionId` is the key
// the mint takes; owner/repo are the card's evidence of what the grant acts on.
const publicConnection = (integration: any) => ({
  connectionId: String(integration.installationId || integration._id || ''),
  owner: String(integration.config?.owner || ''),
  repo: String(integration.config?.repo || ''),
});

/**
 * Sam's option A is two lists (tools plan): the Tools page draws these rows,
 * the Connectors page skips them by `list`. A tool row carries what its Add
 * form needs — the allow-list projected from the broker's definitions, the
 * broker it names, and the caller's own Connections — and never a credential.
 */
const toolEntriesFor = async (userId: string, locale?: string): Promise<unknown[]> => {
  const rows = (await Installable.find({
    source: 'builtin',
    status: 'active',
    'components.type': 'mcp-server',
  }).lean() as any[]).filter((row) => mcpComponentOf(row) && TOOL_INSTALLABLES[row.installableId]);
  if (!rows.length) return [];
  const connectionTypes = Array.from(new Set(rows.map((row) => TOOL_INSTALLABLES[row.installableId].connectionType)));
  const connections = await Integration.find({
    type: { $in: connectionTypes },
    createdBy: userId,
    status: 'connected',
    revokedAt: null,
  }).lean() as any[];
  return rows.map((row) => {
    const meta = TOOL_INSTALLABLES[row.installableId];
    const component = mcpComponentOf(row);
    const readiness = meta.readiness();
    return {
      installableId: row.installableId,
      list: 'tools',
      label: row.name || row.installableId,
      description: localizedDescription(row, locale),
      available: readiness.available,
      ...(readiness.available ? {} : { unavailableReason: readiness.reason }),
      broker: { id: String(component?.name || '') },
      tools: projectTools(component),
      connections: connections
        .filter((integration) => integration.type === meta.connectionType)
        .map(publicConnection),
      installation: null,
      integration: null,
    };
  });
};

const catalogFor = async (userId: string, locale = 'en'): Promise<{ installables: unknown[] }> => {
  const installableIds = providerInstallableIds();
  const [installables, installations] = await Promise.all([
    Installable.find({
      installableId: { $in: installableIds },
      source: 'builtin',
      status: 'active',
    }).lean(),
    InstallableInstallation.find({
      installableId: { $in: installableIds },
      targetType: 'user',
      targetId: userId,
      status: { $ne: 'uninstalled' },
    }).lean(),
  ]);
  const installableById = new Map(
    (installables as any[]).map((installable) => [installable.installableId, installable]),
  );
  const installationById = new Map(
    (installations as any[]).map((installation) => [installation.installableId, installation]),
  );
  const installationIds = (installations as any[]).map((installation) => String(installation._id));
  const integrations = installationIds.length
    ? await Integration.find({ installationId: { $in: installationIds } }).lean()
    : [];
  const integrationByInstallationId = new Map(
    (integrations as any[]).map((integration) => [integration.installationId, integration]),
  );

  const tools = await toolEntriesFor(userId, locale);
  return {
    installables: [...installableIds.map((installableId) => {
      const installable = installableById.get(installableId);
      const installation = installationById.get(installableId);
      const readiness = providerReadiness(installableId) || { available: true };
      return {
        installableId,
        list: 'channels',
        label: installable?.name || installableId,
        description: localizedDescription(installable, locale),
        available: readiness.available,
        ...(readiness.reason ? { unavailableReason: readiness.reason } : {}),
        installation: publicInstallation(installation),
        integration: installation
          ? publicIntegration(integrationByInstallationId.get(String(installation._id)) || null)
          : null,
      };
    }), ...tools],
  };
};

module.exports = {
  catalogFor,
  providerReadiness,
  publicIntegration,
  localizedDescription,
};

export {};
