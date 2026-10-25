/**
 * Where the loopback bridge lives. loopback-bridge.mjs is a script, run by
 * path inside a bwrap network namespace (`node <bridge> ...`), never imported:
 * the namespace mounts that one file, so it uses node built-ins only and
 * cannot resolve a package. Callers bind LOOPBACK_BRIDGE read-only and run it.
 */
import { fileURLToPath } from 'node:url';

export const LOOPBACK_BRIDGE = fileURLToPath(new URL('./loopback-bridge.mjs', import.meta.url));
