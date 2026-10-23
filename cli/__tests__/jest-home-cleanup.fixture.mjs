import { expect, test } from '@jest/globals';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

test('the isolated MCP home exists during the test file', () => {
  expect(existsSync(join(process.env.COMMONLY_MCP_HOME, '.warm.lock'))).toBe(true);
});
