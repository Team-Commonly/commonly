// Rows the platform writes are stored under the account they are about or
// speak for: a system line under its agent or claimer (F434), an approval or
// run-request card and a kernel intro or nudge under the agent (F440). That
// account did not write them, so it gets no author rights over them (F438).
//
// An agent can post only one card shape itself, `{ kind: 'ui' }`
// (uiCardValidation), so any other card is the platform's.

export type PlatformAuthoredKind = 'system_line' | 'platform_post';

interface MessageShape {
  message_type?: string | null;
  author_kind?: string | null;
  payload?: unknown;
}

const payloadKind = (payload: unknown): unknown => {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return value && typeof value === 'object' ? (value as { kind?: unknown }).kind : undefined;
};

export function platformAuthoredKind(message: MessageShape | null | undefined): PlatformAuthoredKind | null {
  if (!message) return null;
  if (message.message_type === 'system') return 'system_line';
  if (message.author_kind === 'kernel') return 'platform_post';
  if (message.message_type === 'card' && payloadKind(message.payload) !== 'ui') return 'platform_post';
  return null;
}

export default { platformAuthoredKind };
