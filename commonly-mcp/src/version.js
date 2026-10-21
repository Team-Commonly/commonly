/**
 * The package's own version, read from the package.json that ships with it.
 *
 * The MCP handshake, the User-Agent and the registry listing all report it, so
 * it has one source. Hard-coded copies drifted: the handshake said 0.1.9 from
 * 0.1.9 through 0.3.13.
 */

import { readFileSync } from 'fs';

export const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
