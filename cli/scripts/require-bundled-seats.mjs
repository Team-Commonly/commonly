// prepack: refuse to pack the CLI without its bundled runtime package.
// `npm pack` on a tree where npm ci has not run exits 0 and silently leaves
// node_modules/@commonlyai/seats out of the tarball, which would publish a CLI
// whose adapters cannot load.
import { existsSync } from 'fs';

const manifest = new URL('../node_modules/@commonlyai/seats/package.json', import.meta.url);
if (!existsSync(manifest)) {
  console.error('@commonlyai/seats is not installed in cli/node_modules; run `npm ci` in cli/ before packing or publishing');
  process.exit(1);
}
