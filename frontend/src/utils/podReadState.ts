interface Message {
  createdAt?: unknown;
  created_at?: unknown;
  timestamp?: unknown;
  updatedAt?: unknown;
  updated_at?: unknown;
}

const buildPodReadCursorKey = (userId: string | null | undefined, podId: string | null | undefined): string | null => {
  if (!userId || !podId) return null;
  return `podLastRead:${userId}:${podId}`;
};

const toTimestampMs = (value: unknown): number | null => {
  if (!value) return null;
  const parsed = new Date(value as string | number).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const readPodLastReadAt = (userId: string | null | undefined, podId: string | null | undefined): number | null => {
  const key = buildPodReadCursorKey(userId, podId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    return toTimestampMs(raw);
  } catch (_error) {
    return null;
  }
};

const writePodLastReadAt = (userId: string | null | undefined, podId: string | null | undefined, timestampMs: number): void => {
  const key = buildPodReadCursorKey(userId, podId);
  if (!key || !Number.isFinite(timestampMs) || timestampMs <= 0) return;
  try {
    window.localStorage.setItem(key, String(timestampMs));
  } catch (_error) {
    // Ignore localStorage write failures.
  }
};

const resolveMessageTimestampMs = (message: Message | null | undefined): number | null => {
  if (!message || typeof message !== 'object') return null;
  return (
    toTimestampMs(message.createdAt) ||
    toTimestampMs(message.created_at) ||
    toTimestampMs(message.timestamp) ||
    toTimestampMs(message.updatedAt) ||
    toTimestampMs(message.updated_at)
  );
};

const resolveLatestMessageTimestampMs = (messages: Message[] = []): number | null => {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return messages.reduce<number | null>((latest, message) => {
    const nextValue = resolveMessageTimestampMs(message);
    if (!nextValue) return latest;
    return !latest || nextValue > latest ? nextValue : latest;
  }, null);
};

const markPodReadFromMessages = ({
  userId,
  podId,
  messages,
}: {
  userId: string | null | undefined;
  podId: string | null | undefined;
  messages: Message[];
}): number | null => {
  const latestTimestamp = resolveLatestMessageTimestampMs(messages);
  if (!latestTimestamp) return null;
  const previous = readPodLastReadAt(userId, podId);
  const nextValue = previous ? Math.max(previous, latestTimestamp) : latestTimestamp;
  writePodLastReadAt(userId, podId, nextValue);
  return nextValue;
};

export {
  buildPodReadCursorKey,
  readPodLastReadAt,
  writePodLastReadAt,
  resolveMessageTimestampMs,
  resolveLatestMessageTimestampMs,
  markPodReadFromMessages,
};
