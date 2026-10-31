/**
 * sdk-bundle.test.mjs — TASK-300. The npm package must ship the webhook SDK and
 * bot that `agent init` copies. prepack runs bundle-sdk-examples.mjs, which
 * copies them from examples/ into assets/. This pins that the bundled copies are
 * byte-identical to the source, so the package cannot carry a stale SDK.
 */

import { beforeAll, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const CLI_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO_ROOT = path.resolve(CLI_ROOT, '..');

const PAIRS = [
  [path.join(REPO_ROOT, 'examples', 'sdk', 'python', 'commonly.py'), path.join('python', 'commonly.py')],
  [path.join(REPO_ROOT, 'examples', 'hello-world-python', 'bot.py'), path.join('python', 'bot.py')],
];

describe('bundled webhook SDK (TASK-300)', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(CLI_ROOT, 'scripts', 'bundle-sdk-examples.mjs')]);
  });

  it.each(PAIRS)('ships %s byte-identical to the examples/ source', (src, rel) => {
    const bundled = path.join(CLI_ROOT, 'assets', 'webhook-sdk', rel);
    expect(fs.existsSync(bundled)).toBe(true);
    expect(fs.readFileSync(bundled).equals(fs.readFileSync(src))).toBe(true);
  });
});
