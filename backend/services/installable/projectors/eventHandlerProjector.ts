import type { IComponent } from '../../../models/Installable';
import type { ComponentProjector, ProjectionContext, ProjectionIds } from './types';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { hasEventHandler } = require('../eventHandlers');

export const eventHandlerProjector: ComponentProjector = {
  type: 'event-handler',

  async project(component: IComponent, context: ProjectionContext): Promise<ProjectionIds> {
    const handler = component.eventHandler;
    if (!handler || !hasEventHandler(handler)) {
      throw new Error(`Unknown internal event handler: ${handler || '(missing)'}`);
    }

    const integration = await Integration.findOne({
      installationId: String(context.installation._id),
    });
    if (!integration) {
      throw new Error('Event-handler projection requires its webhook Integration row');
    }
    return { integrationId: integration._id };
  },

  async unproject(
    _component: IComponent,
    _context: ProjectionContext,
    _projectionIds: ProjectionIds,
  ): Promise<void> {
    // The webhook projector owns the shared Integration lifecycle. Removing an
    // event handler only removes its parent component record; it must not
    // deactivate a row another component of the same installation still owns.
  },
};
