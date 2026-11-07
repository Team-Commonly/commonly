import fs from 'fs';
import path from 'path';
import {
  DEFAULT_WORKSPACE_POD_DESCRIPTIONS,
  DEFAULT_WORKSPACE_POD_NAMES,
  isDefaultWorkspaceDescription,
  isDefaultWorkspaceName,
} from '../utils/defaultWorkspacePod';

describe('default workspace pod', () => {
  test('matches what signup stores', () => {
    const backend = fs.readFileSync(
      path.resolve(__dirname, '../../../../backend/config/defaultWorkspacePod.ts'),
      'utf8',
    );
    const stored = Array.from(backend.matchAll(/name: '([^']+)', description: '([^']+)'/g));
    expect(stored.map((row) => row[1])).toEqual(DEFAULT_WORKSPACE_POD_NAMES);
    expect(stored.map((row) => row[2])).toEqual(DEFAULT_WORKSPACE_POD_DESCRIPTIONS);
  });

  test('recognises every locale, and only those', () => {
    expect(isDefaultWorkspaceName('我的工作空间')).toBe(true);
    expect(isDefaultWorkspaceName('Launch')).toBe(false);
    expect(isDefaultWorkspaceName(undefined)).toBe(false);
    expect(isDefaultWorkspaceDescription('你的私人工作空间')).toBe(true);
    expect(isDefaultWorkspaceDescription('A pod')).toBe(false);
  });
});
