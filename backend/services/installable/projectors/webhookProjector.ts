import type { IComponent } from '../../../models/Installable';
import type { ComponentProjector, ProjectionContext, ProjectionIds } from './types';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../../models/Integration');

const INTERNAL_WEBHOOK_PROVIDERS: Record<string, 'telegram'> = {
  '/api/webhooks/telegram': 'telegram',
};

const installationIdFor = (context: ProjectionContext): string => String(context.installation._id);

const resolveProvider = (component: IComponent): 'telegram' => {
  const provider = component.webhookPath
    ? INTERNAL_WEBHOOK_PROVIDERS[component.webhookPath]
    : undefined;
  if (!provider) {
    throw new Error(`Unsupported internal webhook path: ${component.webhookPath || '(missing)'}`);
  }
  return provider;
};

export const webhookProjector: ComponentProjector = {
  type: 'webhook',

  async project(component: IComponent, context: ProjectionContext): Promise<ProjectionIds> {
    const provider = resolveProvider(component);
    const installationId = installationIdFor(context);
    if (!context.podId) {
      throw new Error('Webhook projection requires a pod target');
    }

    // Projection never mints a code. A partially projected row must remain
    // impossible for the unauthenticated enable route to redeem.
    const integration = await Integration.findOneAndUpdate(
      { installationId },
      {
        $setOnInsert: {
          installationId,
          installationClaimId: context.claimId,
          podId: context.podId,
          type: provider,
          status: 'pending',
          createdBy: context.installedBy,
          isActive: false,
          config: {
            liveRelay: true,
            relayAllAgentMessages: true,
            linkedUserId: String(context.installedBy),
          },
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    if (!integration) throw new Error('Webhook projection did not return an Integration row');
    return { integrationId: integration._id };
  },

  async unproject(
    _component: IComponent,
    context: ProjectionContext,
    _projectionIds: ProjectionIds,
  ): Promise<void> {
    await Integration.findOneAndUpdate(
      { installationId: installationIdFor(context) },
      {
        // Carry the revocation generation onto the projection before the
        // parent can become uninstalled. An in-flight stale activation then
        // cannot match its old generation and revive this connector.
        $set: {
          isActive: false,
          installationClaimId: context.claimId,
          revokedAt: new Date(),
        },
        $unset: {
          'config.connectCode': 1,
          'config.connectCodeExpiresAt': 1,
        },
      },
    );
  },
};
