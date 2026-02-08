const buildPodReadCursorKey = (userId, podId) => {
  if (!userId || !podId) return null;
  return `podLastRead:${userId}:${podId}`;
};

const toTimestampMs = (value) => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const readPodLastReadAt = (userId, podId) => {
  const key = buildPodReadCursorKey(userId, podId);
  if (!key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    return toTimestampMs(raw);
  } catch (error) {
    return null;
  }
};

const writePodLastReadAt = (userId, podId, timestampMs) => {
  const key = buildPodReadCursorKey(userId, podId);
  if (!key || !Number.isFinite(timestampMs) || timestampMs <= 0) return;
  try {
    window.localStorage.setItem(key, String(timestampMs));
  } catch (error) {
    // Ignore localStorage write failures.
  }
};

const resolveMessageTimestampMs = (message) => {
  if (!message || typeof message !== 'object') return null;
  return (
    toTimestampMs(message.createdAt)
    || toTimestampMs(message.created_at)
    || toTimestampMs(message.timestamp)
    || toTimestampMs(message.updatedAt)
    || toTimestampMs(message.updated_at)
  );
};

const resolveLatestMessageTimestampMs = (messages = []) => {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return messages.reduce((latest, message) => {
    const nextValue = resolveMessageTimestampMs(message);
    if (!nextValue) return latest;
    return !latest || nextValue > latest ? nextValue : latest;
  }, null);
};

const markPodReadFromMessages = ({ userId, podId, messages }) => {
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
