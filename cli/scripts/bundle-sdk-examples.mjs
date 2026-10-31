// prepack: copy the webhook SDK and the hello-world bot out of examples/ into
// cli/assets/webhook-sdk/ so the published package ships them. agent init reads
// them from the package. The copies are generated and gitignored; examples/
// stays the source of truth.
import { copyFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliRoot, '..');
const bundles = [
  [join(repoRoot, 'examples', 'sdk', 'python', 'commonly.py'), join('python', 'commonly.py')],
  [join(repoRoot, 'examples', 'hello-world-python', 'bot.py'), join('python', 'bot.py')],
];

for (const [src, rel] of bundles) {
  const dest = join(cliRoot, 'assets', 'webhook-sdk', rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
