// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Installable = require('../../models/Installable');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const InstallableInstallation = require('../../models/InstallableInstallation');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { manifests } = require('../../integrations/manifests');

type ProviderReadiness = { available: boolean; reason?: 'not_configured' };

type ProviderManifest = {
  id: string;
  readiness?: () => ProviderReadiness;
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

// Mongoose's Integration toJSON transform is the normal guard. Keep this
// explicit mapper for lean catalog reads too, so the API can never serialize a
// ConnectorSecret reference or a browser-bound OAuth nonce by accident.
const publicIntegration = (integration: unknown): unknown => {
  if (!integration || typeof integration !== 'object') return integration;
  const raw = typeof (integration as { toJSON?: () => unknown }).toJSON === 'function'
    ? (integration as { toJSON: () => unknown }).toJSON()
    : JSON.parse(JSON.stringify(integration));
  if (!raw || typeof raw !== 'object') return raw;
  const result = raw as { config?: Record<string, unknown> };
  if (!result.config) return result;
  delete result.config.botTokenRef;
  delete result.config.oauthStateNonce;
  const pending = result.config.pendingBind;
  if (pending && typeof pending === 'object') delete (pending as Record<string, unknown>).botTokenRef;
  return result;
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

const catalogFor = async (userId: string): Promise<{ installables: unknown[] }> => {
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

  return {
    installables: installableIds.map((installableId) => {
      const installable = installableById.get(installableId);
      const installation = installationById.get(installableId);
      const readiness = providerReadiness(installableId) || { available: true };
      return {
        installableId,
        label: installable?.name || installableId,
        description: installable?.description || '',
        available: readiness.available,
        ...(readiness.reason ? { unavailableReason: readiness.reason } : {}),
        installation: publicInstallation(installation),
        integration: installation
          ? publicIntegration(integrationByInstallationId.get(String(installation._id)) || null)
          : null,
      };
    }),
  };
};

module.exports = { catalogFor, providerReadiness, publicIntegration };

export {};
