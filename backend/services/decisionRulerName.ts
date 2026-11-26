// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
const User = require('../models/User');

/**
 * F645. A ruling stores the ruler's handle (`byUsername`), the stable key the
 * asking agent's wake carries. People read the display name, so every read of a
 * ruling also sends `byName`: the ruler's displayName, else the handle. One
 * read covers a page of rows; a ruler who is gone falls back to the stored handle.
 */
export const rulerNamesFor = async (rows: any[]): Promise<Map<string, string>> => {
  const ids = [...new Set(rows
    .map((row) => String(row?.ruling?.byUserId || ''))
    .filter((id) => /^[a-f0-9]{24}$/i.test(id)))];
  if (!ids.length) return new Map();
  try {
    const users = await User.find({ _id: { $in: ids } }).select('username displayName').lean() as Array<{
      _id: unknown; username?: string; displayName?: string;
    }>;
    return new Map(users
      .filter((user) => user.displayName?.trim() || user.username)
      .map((user) => [String(user._id), String(user.displayName?.trim() || user.username)]));
  } catch {
    // A name is display only. The ruling still reads with its stored handle.
    return new Map();
  }
};

export const rulerNameOf = (row: any, names: Map<string, string>): string | undefined => {
  const ruling = row?.ruling;
  if (!ruling) return undefined;
  return names.get(String(ruling.byUserId || '')) || ruling.byUsername || undefined;
};
