/**
 * Targets are data: `{ cli, version, adapter: 'module#export', binary?, enabled,
 * requires?, options?, timeouts?, note? }`. This module turns one entry into
 * an adapter and a binary path, or into the reason it cannot run.
 *
 * Module specs resolve against the package root, so `src/adapters/stub.js`
 * means packages/seats/src/adapters/stub.js wherever the runner is started.
 * The export may be an adapter object or a factory taking `options`.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

export const parseAdapterSpec = (spec) => {
  const [file, name = 'default'] = String(spec || '').split('#');
  if (!file) throw new Error(`adapter spec ${JSON.stringify(spec)} names no module`);
  return { file, exportName: name, path: isAbsolute(file) ? file : join(PACKAGE_ROOT, file) };
};

/** Where install.js puts a target, and where run.js looks for it. */
export const installDirOf = (target, prefix) => join(prefix, `${target.cli}-${target.version}`);

const expand = (value) => String(value)
  .replace(/^~(?=$|\/)/, homedir())
  .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');

/**
 * The binary a target runs, as `{ path, label }` (label is prefix-relative so a
 * published page never carries a host's home directory), `null` when the
 * target names none, or `{ missing }` when it cannot run on this host.
 */
export const resolveBinary = (target, { prefix, platform = platformKey() } = {}) => {
  const binary = target.binary;
  if (!binary) return null;
  if (binary.path) return { path: expand(binary.path), label: binary.path };
  const bin = typeof binary.bin === 'string' ? binary.bin : binary.bin?.[platform];
  if (!bin) return { missing: `no ${target.cli} binary is pinned for ${platform}` };
  if (binary.release && !binary.release[platform]) return { missing: `no ${target.cli} release asset is pinned for ${platform}` };
  if (!prefix) return { missing: 'no install prefix given (--prefix or COMPAT_PREFIX)' };
  return { path: join(installDirOf(target, expand(prefix)), bin), label: `<prefix>/${target.cli}-${target.version}/${bin}` };
};

/**
 * @returns {Promise<{ adapter } | { skip: string } | { error: string }>}
 */
export const loadAdapter = async (target, { binaryPath } = {}) => {
  let spec;
  try { spec = parseAdapterSpec(target.adapter); } catch (error) { return { error: error.message }; }
  if (!existsSync(spec.path)) {
    const why = target.requires ? ` (requires: ${target.requires})` : '';
    return { skip: `adapter module ${spec.file} is not present${why}` };
  }
  let mod;
  try { mod = await import(pathToFileURL(spec.path).href); } catch (error) {
    return { error: `importing ${spec.file} failed: ${error?.message || error}` };
  }
  const exported = mod[spec.exportName];
  if (exported === undefined) return { error: `${spec.file} has no export ${spec.exportName}` };
  let adapter = exported;
  if (typeof exported === 'function') {
    try {
      adapter = await exported({ ...(target.options || {}), ...(binaryPath ? { binaryPath } : {}) });
    } catch (error) {
      return { error: `${spec.file}#${spec.exportName}(options) threw: ${error?.message || error}` };
    }
  }
  if (!adapter || typeof adapter.spawn !== 'function' || typeof adapter.detect !== 'function') {
    return { error: `${target.adapter} is not an adapter (needs detect() and spawn())` };
  }
  return { adapter };
};

export const targetLabel = (target) => `${target.cli}@${target.version}`;
