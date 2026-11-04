// The chat-relay adapter registry: one entry per external chat platform whose
// bridge relays pod messages outward. The installable dispatcher reads its keys
// for the Integration types it selects and its adapters for the
// `<provider>.relay` handlers, so a new platform is an adapter in its bridge
// plus one line here — no dispatcher edit.

import { relayAgentMessageThroughAdapter } from './chatRelayCore';
import type { ChatRelayAdapter, OutboundRelayOptions } from './chatRelayCore';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { telegramRelayAdapter } = require('../telegramBridgeService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { slackRelayAdapter } = require('../slackBridgeService');

export const chatRelayAdapters: Record<string, ChatRelayAdapter<any>> = {
  telegram: telegramRelayAdapter,
  slack: slackRelayAdapter,
};

/** Integration.type values the dispatcher selects for outbound relay. */
export const chatRelayIntegrationTypes = (): string[] => Object.keys(chatRelayAdapters);

/** `{ 'telegram.relay': fn, 'slack.relay': fn }` — the dispatcher's handler entries. */
export const chatRelayEventHandlers = (): Record<string, (opts: OutboundRelayOptions<any>) => Promise<void>> => (
  Object.fromEntries(Object.entries(chatRelayAdapters).map(([provider, adapter]) => [
    `${provider}.relay`,
    (opts: OutboundRelayOptions<any>) => relayAgentMessageThroughAdapter(adapter, opts),
  ]))
);
