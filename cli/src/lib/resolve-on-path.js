import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * The first executable `name` on `pathValue`, absolute, or null. No shell
 * involved, and only absolute PATH entries count: a relative entry would
 * resolve against whatever the daemon's working directory happens to be.
 * Only a file counts: X_OK passes a directory, and execvp passes over one
 * (EACCES) to the next entry, so a same-named folder earlier on PATH must not
 * be returned as the binary (F146).
 */
export const resolveOnPath = (name, pathValue) => {
  for (const dir of String(pathValue || '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* next */ }
  }
  return null;
};
