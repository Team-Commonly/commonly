/**
 * The backend and published CLI cannot share a runtime import, but their loop
 * budgets must start from the same event population. The wrapper then keeps
 * DM-backed chat.mention events on its local bounded path via payload.dmKind;
 * import both modules here instead of relying on two comments to keep the
 * mirrored base lists aligned.
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..', '..', 'backend');
const backendPackage = join(backendRoot, 'package.json');
const backendService = join(backendRoot, 'services', 'agentMentionService.ts');
const cliEnforcement = pathToFileURL(join(here, '..', 'src', 'lib', 'enforcement.js')).href;

const loadMentionEventTypes = () => {
  // Jest owns require.extensions and cannot execute backend TypeScript through
  // ts-node in-process. A plain Node child has no such interception, so this
  // imports the real backend service and the real CLI module rather than
  // comparing a duplicated fixture or parsing source text.
  const script = `
    import { createRequire } from 'module';
    const requireBackend = createRequire(${JSON.stringify(backendPackage)});
    requireBackend('ts-node/register/transpile-only');
    const { MENTION_EVENT_TYPES: backendTypes } = requireBackend(${JSON.stringify(backendService)});
    const { MENTION_EVENT_TYPES: cliTypes } = await import(${JSON.stringify(cliEnforcement)});
    console.log(JSON.stringify({ backend: [...backendTypes], cli: [...cliTypes] }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    env: { ...process.env, TS_NODE_PROJECT: join(backendRoot, 'tsconfig.json') },
  });
  return JSON.parse(output.trim().split('\n').at(-1));
};

describe('mention dampener ↔ wrapper cascade contract', () => {
  test('the wrapper starts its non-DM exemption from the kernel event types', () => {
    const { backend, cli } = loadMentionEventTypes();
    expect(cli).toEqual(backend);
  });
});
