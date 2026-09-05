import type { IIntegration } from '../../models/Integration';
import { Types } from 'mongoose';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Integration = require('../../models/Integration');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const Pod = require('../../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const telegramBridgeService = require('../telegramBridgeService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const slackBridgeService = require('../slackBridgeService');

export interface ChatMessageEventPayload {
  podId: string;
  agentUsername: string;
  displayName: string;
  content: string;
  podMessageId?: string | null;
}

export type InternalEventHandler = (
  payload: ChatMessageEventPayload & { integration: IIntegration },
) => Promise<void>;

// The registry is intentionally a mutable object rather than a switch so
// component tests can pin selection at this seam and future component types
// add one registration instead of another dispatcher branch.
export const eventHandlers: Record<string, InternalEventHandler> = {
  'telegram.relay': telegramBridgeService.relayAgentMessageToTelegram,
  'slack.relay': slackBridgeService.relayAgentMessageToSlack,
};

export const hasEventHandler = (reference: string): boolean => (
  reference.startsWith('internal:')
  && typeof eventHandlers[reference.slice('internal:'.length)] === 'function'
);

const activeHandlersForPod = async (podId: string): Promise<Array<{
  integration: IIntegration;
  handler: string;
}>> => {
  // Selection starts from the pod's current membership. A user-scoped
  // connector is private to its owner, so a stale gate can never relay after
  // that owner leaves even before the reconciler prunes the key. Legacy rows
  // retain their pod-scoped selection until they are explicitly migrated.
  if (!Types.ObjectId.isValid(podId)) return [];
  const pod = await Pod.findById(podId).select('createdBy members').lean() as {
    createdBy?: unknown;
    members?: unknown[];
  } | null;
  if (!pod) return [];
  const memberIds = Array.from(new Set([
    pod.createdBy,
    ...(pod.members || []),
  ].filter(Boolean).map((id) => String(id)))).map((id) => new Types.ObjectId(id));
  if (!memberIds.length) return [];
  const gateEnabledPath = `config.gates.${String(podId)}.enabled`;
  return Integration.aggregate([
    {
      $match: {
        type: { $in: ['telegram', 'slack'] },
        isActive: true,
        status: { $ne: 'error' },
        'config.liveRelay': true,
        'config.adminPause': { $exists: false },
        $or: [
          {
            scope: { $ne: 'user' },
            podId: new Types.ObjectId(podId),
          },
          {
            scope: 'user',
            createdBy: { $in: memberIds },
            [gateEnabledPath]: true,
          },
        ],
      },
    },
    {
      $lookup: {
        from: 'installableinstallations',
        let: { installationId: '$installationId' },
        pipeline: [
          {
            $match: {
              $expr: { $eq: [{ $toString: '$_id' }, '$$installationId'] },
            },
          },
          {
            $match: {
              status: 'active',
              components: {
                $elemMatch: {
                  componentType: 'event-handler',
                  status: 'active',
                  'config.eventType': 'chat.message',
                },
              },
            },
          },
        ],
        as: 'installation',
      },
    },
    {
      $project: {
        integration: '$$ROOT',
        // Existing direct Integration rows predate D17. The old live-relay
        // shape is Telegram-only; Slack is always an Installable projection
        // because its token is an opaque ConnectorSecret reference.
        handlers: {
          $cond: [
            {
              $and: [
                { $eq: [{ $ifNull: ['$installationId', null] }, null] },
                { $eq: ['$type', 'telegram'] },
              ],
            },
            [{ config: { eventHandler: 'internal:telegram.relay' } }],
            {
              $let: {
                vars: { parent: { $arrayElemAt: ['$installation', 0] } },
                in: {
                  $cond: [
                    { $eq: ['$$parent.status', 'active'] },
                    {
                      $filter: {
                        input: '$$parent.components',
                        as: 'component',
                        cond: {
                          $and: [
                            { $eq: ['$$component.componentType', 'event-handler'] },
                            { $eq: ['$$component.status', 'active'] },
                            { $eq: ['$$component.config.eventType', 'chat.message'] },
                          ],
                        },
                      },
                    },
                    [],
                  ],
                },
              },
            },
          ],
        },
      },
    },
    { $unwind: '$handlers' },
    { $project: { integration: 1, handler: '$handlers.config.eventHandler' } },
  ]);
};

export const dispatch = async (
  eventType: 'chat.message',
  payload: ChatMessageEventPayload,
): Promise<void> => {
  if (eventType !== 'chat.message') return;

  let selected: Array<{ integration: IIntegration; handler: string }>;
  try {
    selected = await activeHandlersForPod(payload.podId);
  } catch (error) {
    console.warn('[installable-dispatch] selector failed:', (error as Error).message);
    return;
  }

  await Promise.all(selected.map(async ({ integration, handler }) => {
    const callback = eventHandlers[String(handler).replace(/^internal:/, '')];
    if (!callback) {
      console.warn('[installable-dispatch] unregistered handler:', handler);
      return;
    }
    try {
      await callback({ ...payload, integration });
    } catch (error) {
      console.warn('[installable-dispatch] handler failed:', (error as Error).message);
    }
  }));
};

module.exports = {
  eventHandlers,
  hasEventHandler,
  activeHandlersForPod,
  dispatch,
};
