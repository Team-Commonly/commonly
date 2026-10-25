// Shared gateway logs are visible only through the requested account tags.
export const filterRuntimeAccountLogs = (logs: string, filterTokens: unknown[] = []): string => {
  const tokens = filterTokens.map((token) => String(token || '').trim()).filter(Boolean);
  if (!tokens.length) return logs;
  return logs.split('\n')
    .filter((line) => {
      const account = line.match(/\[commonly\] \[([^\]]+)\]/);
      return Boolean(account && tokens.includes(account[1]));
    })
    .join('\n');
};
