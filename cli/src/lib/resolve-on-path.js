import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * The first executable `name` on `pathValue`, absolute, or null. No shell
 * involved, and only absolute PATH entries count: a relative entry would
 * resolve against whatever the daemon's working directory happens to be.
 */
export const resolveOnPath = (name, pathValue) => {
  for (const dir of String(pathValue || '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return null;
};
