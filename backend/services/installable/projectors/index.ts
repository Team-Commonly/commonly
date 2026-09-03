import { eventHandlerProjector } from './eventHandlerProjector';
import type { ComponentProjector } from './types';
import { webhookProjector } from './webhookProjector';

export const projectorRegistry: Map<string, ComponentProjector> = new Map([
  [webhookProjector.type, webhookProjector],
  [eventHandlerProjector.type, eventHandlerProjector],
]);

export const getProjector = (type: string): ComponentProjector | undefined => projectorRegistry.get(type);

module.exports = {
  projectorRegistry,
  getProjector,
};
