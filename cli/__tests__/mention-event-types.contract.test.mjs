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

const backendDependencyHint =
  `the cli contract suite reads backend TypeScript through ts-node from ${backendRoot}, which the cli `
  + 'package does not install. Remedy: `cd backend && npm ci` — and in a git worktree that means '
  + 'backend/node_modules must exist (symlink the main checkout\'s), because nothing else provides it.';

/**
 * A bare `Cannot find module` from the child reads like a code failure in this
 * suite, and it has twice sent a reader hunting for a defect that was a missing
 * install (docs/development/agent-experience-audit.md, entry 57). The failure
 * therefore names the module, the root it was resolved from, and the remedy.
 */
export const explainBackendDependencyFailure = (error) => {
  const detail = `${error?.stderr ?? ''}${error?.message ?? ''}`.trim();
  return new Error(
    `the cli contract suite could not load backend dependencies: `
    + `${detail || 'the child process failed without output'}. ${backendDependencyHint}`,
    { cause: error },
  );
};

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
  let output;
  try {
    output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, TS_NODE_PROJECT: join(backendRoot, 'tsconfig.json') },
    });
  } catch (error) {
    throw explainBackendDependencyFailure(error);
  }
  return JSON.parse(output.trim().split('\n').at(-1));
};

describe('mention dampener ↔ wrapper cascade contract', () => {
  test('the wrapper starts its non-DM exemption from the kernel event types', () => {
    const { backend, cli } = loadMentionEventTypes();
    expect(cli).toEqual(backend);
  });
});

describe('a missing backend dependency explains itself', () => {
  test('the failure names the module, the root it was looked for in, and the remedy', () => {
    const childFailure = new Error('Command failed: node --input-type=module --eval ');
    childFailure.stderr = "Error: Cannot find module 'ts-node/register/transpile-only'\n";
    const explained = explainBackendDependencyFailure(childFailure);
    expect(explained.message).toContain("Cannot find module 'ts-node/register/transpile-only'");
    expect(explained.message).toContain(backendRoot);
    expect(explained.message).toContain('cd backend && npm ci');
    expect(explained.cause).toBe(childFailure);
  });
});
