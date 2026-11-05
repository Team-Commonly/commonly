// The chat-relay adapter registry: one entry per external chat platform whose
// bridge relays pod messages outward. The installable dispatcher reads its keys
// for the Integration types it selects and its adapters for the
// `<provider>.relay` handlers, so a new platform is an adapter in its bridge
// plus one line here — no dispatcher edit.

import { privateChatLiveRelayRefusal, relayAgentMessageThroughAdapter } from './chatRelayCore';
import type {
  ChatRelayAdapter, InboundRelayAdapter, LiveRelayRow, OutboundRelayOptions,
} from './chatRelayCore';

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { telegramRelayAdapter, telegramInboundAdapter } = require('../telegramBridgeService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { slackRelayAdapter, slackInboundAdapter } = require('../slackBridgeService');
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { discordRelayAdapter, discordInboundAdapter } = require('../discordBridgeService');

export const chatRelayAdapters: Record<string, ChatRelayAdapter<any>> = {
  telegram: telegramRelayAdapter,
  slack: slackRelayAdapter,
  discord: discordRelayAdapter,
};

/** Integration.type values the dispatcher selects for outbound relay. */
export const chatRelayIntegrationTypes = (): string[] => Object.keys(chatRelayAdapters);

/** The types whose rows relay with no Installable parent (see ChatRelayAdapter.directRows). */
export const chatRelayDirectRowTypes = (): string[] => (
  Object.entries(chatRelayAdapters).filter(([, adapter]) => adapter.directRows === true).map(([type]) => type)
);

/** `{ 'telegram.relay': fn, 'slack.relay': fn }` — the dispatcher's handler entries. */
export const chatRelayEventHandlers = (): Record<string, (opts: OutboundRelayOptions<any>) => Promise<void>> => (
  Object.fromEntries(Object.entries(chatRelayAdapters).map(([provider, adapter]) => [
    `${provider}.relay`,
    (opts: OutboundRelayOptions<any>) => relayAgentMessageThroughAdapter(adapter, opts),
  ]))
);

// ---------------------------------------------------------------------------
// Inbound — one entry per platform whose bridge relays chat lines INTO a pod.
// A platform can relay inbound without relaying outbound (Discord did, F131,
// until F132), so this registry is separate from the outbound one above.
// ---------------------------------------------------------------------------

export const inboundRelayAdapters: Record<string, InboundRelayAdapter<any, any>> = {
  telegram: telegramInboundAdapter,
  slack: slackInboundAdapter,
  discord: discordInboundAdapter,
};

/**
 * Why `liveRelay` may not go on for a row of this type, or null. The platform's
 * own declaration when it has one; otherwise the private-chat rule every chat
 * connector had before adapters declared their own.
 */
export const liveRelayRefusalFor = (
  type: unknown,
  row: LiveRelayRow,
  requesterId: string,
): string | null => {
  const adapter = typeof type === 'string' && Object.prototype.hasOwnProperty.call(inboundRelayAdapters, type)
    ? inboundRelayAdapters[type]
    : null;
  return adapter ? adapter.liveRelayRefusal(row, requesterId) : privateChatLiveRelayRefusal(row);
};
