/**
 * memory-import.js unit tests (ESM) — retention plan Phase C.
 *
 * Filesystem: real temp directories (detection walks the FS). The kernel
 * client is a stub capturing calls.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';

import {
  detectMemorySources,
  composeImport,
  importMemory,
  claudeProjectMemoryDir,
  MAX_IMPORT_BYTES,
  SOURCE_RUNTIME,
} from '../src/lib/memory-import.js';
import { runMemoryImport } from '../src/commands/agent.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const makeProject = () => {
  const cwd = tmp('mi-cwd-');
  const home = tmp('mi-home-');
  return { cwd, home };
};

const write = (dir, name, content) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
  return path.join(dir, name);
};

const stubClient = ({ existing = null, getError = null } = {}) => {
  const calls = { get: [], post: [] };
  return {
    calls,
    get: async (url) => {
      calls.get.push(url);
      if (getError) throw getError;
      if (existing === null) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
      return { sections: { long_term: { content: existing } } };
    },
    post: async (url, body) => {
      calls.post.push({ url, body });
      return {};
    },
  };
};

describe('detectMemorySources', () => {
  test('finds project CLAUDE.md, MEMORY.md, and the ~/.claude auto-memory dir', () => {
    const { cwd, home } = makeProject();
    write(cwd, 'CLAUDE.md', '# instructions');
    write(cwd, 'MEMORY.md', '# memory');
    const memDir = claudeProjectMemoryDir(cwd, home);
    write(memDir, 'MEMORY.md', '# index');
    write(memDir, 'project-foo.md', '# foo');

    const sources = detectMemorySources({ cwd, home });
    expect(sources.map((s) => path.basename(s.path))).toEqual([
      'CLAUDE.md', 'MEMORY.md', 'MEMORY.md', 'project-foo.md',
    ]);
  });

  test('collapses symlink duplicates (AGENTS.md → CLAUDE.md)', () => {
    const { cwd, home } = makeProject();
    const claude = write(cwd, 'CLAUDE.md', '# instructions');
    fs.symlinkSync(claude, path.join(cwd, 'AGENTS.md'));

    const sources = detectMemorySources({ cwd, home });
    expect(sources).toHaveLength(1);
  });

  test('skips empty files and returns [] when nothing exists', () => {
    const { cwd, home } = makeProject();
    write(cwd, 'CLAUDE.md', '');
    expect(detectMemorySources({ cwd, home })).toEqual([]);
  });

  test('explicit file path wins; explicit dir takes all .md files', () => {
    const { cwd, home } = makeProject();
    write(cwd, 'CLAUDE.md', '# would be auto-detected');
    const dir = tmp('mi-explicit-');
    write(dir, 'b.md', 'bee');
    write(dir, 'a.md', 'ay');
    write(dir, 'notes.txt', 'ignored');

    const single = detectMemorySources({ cwd, home, explicitPath: path.join(dir, 'a.md') });
    expect(single).toHaveLength(1);

    const all = detectMemorySources({ cwd, home, explicitPath: dir });
    expect(all.map((s) => path.basename(s.path))).toEqual(['a.md', 'b.md']);
  });

  test('explicit path that does not exist throws', () => {
    const { cwd, home } = makeProject();
    expect(() => detectMemorySources({ cwd, home, explicitPath: '/no/such/file.md' })).toThrow(/No such file/);
  });
});

describe('composeImport', () => {
  test('joins sources with provenance headers', () => {
    const { cwd } = makeProject();
    const p = write(cwd, 'MEMORY.md', 'remember the milk');
    const doc = composeImport([{ path: p, label: 'project memory', bytes: 17 }]);
    expect(doc).toContain('# Imported local memory');
    expect(doc).toContain('## Imported: MEMORY.md (project memory)');
    expect(doc).toContain('remember the milk');
  });

  test('enforces the size ceiling', () => {
    const { cwd } = makeProject();
    const p = write(cwd, 'big.md', 'x');
    expect(() => composeImport([{ path: p, label: 'big', bytes: MAX_IMPORT_BYTES + 1 }]))
      .toThrow(/ceiling/);
  });
});

describe('importMemory', () => {
  const sourcesFor = (content = 'hello') => {
    const { cwd } = makeProject();
    const p = write(cwd, 'MEMORY.md', content);
    return [{ path: p, label: 'project memory', bytes: content.length }];
  };

  test('fresh agent (404): sends the import as the whole long_term, patch mode', async () => {
    const client = stubClient();
    const result = await importMemory(client, { sources: sourcesFor() });

    expect(result.appended).toBe(false);
    expect(client.calls.post).toHaveLength(1);
    const { url, body } = client.calls.post[0];
    expect(url).toBe('/api/agents/runtime/memory/sync');
    expect(body.mode).toBe('patch');
    expect(body.sourceRuntime).toBe(SOURCE_RUNTIME);
    expect(body.sections.long_term.visibility).toBe('private');
    expect(body.sections.long_term.content).toMatch(/^# Imported local memory/);
  });

  test('existing memory: appends after it (patch replaces the whole section)', async () => {
    const client = stubClient({ existing: '## Already learned\nthings' });
    const result = await importMemory(client, { sources: sourcesFor() });

    expect(result.appended).toBe(true);
    const content = client.calls.post[0].body.sections.long_term.content;
    expect(content.startsWith('## Already learned')).toBe(true);
    expect(content).toContain('# Imported local memory');
  });

  test('a non-404 read failure aborts the import (no blind clobber)', async () => {
    const err = new Error('backend down');
    err.status = 500;
    const client = stubClient({ getError: err });
    await expect(importMemory(client, { sources: sourcesFor() })).rejects.toThrow('backend down');
    expect(client.calls.post).toHaveLength(0);
  });
});

describe('runMemoryImport (confirm flow)', () => {
  test('declined prompt sends nothing', async () => {
    const { cwd, home } = makeProject();
    write(cwd, 'MEMORY.md', 'secret stuff');
    const client = stubClient();

    const result = await runMemoryImport({
      client,
      cwd,
      log: () => {},
      promptFn: async () => 'n',
      // home isn't injectable through runMemoryImport; auto-detect also
      // scans the real ~/.claude — harmless, cwd file suffices for this test.
    });

    expect(result.imported).toBe(false);
    expect(result.reason).toBe('declined');
    expect(client.calls.post).toHaveLength(0);
  });

  test('--yes imports without prompting', async () => {
    const { cwd } = makeProject();
    write(cwd, 'MEMORY.md', 'ship it');
    const client = stubClient();

    const result = await runMemoryImport({ client, cwd, yes: true, log: () => {} });

    expect(result.imported).toBe(true);
    expect(client.calls.post).toHaveLength(1);
  });

  test('nothing found is a clean no-op', async () => {
    const { cwd } = makeProject();
    const client = stubClient();
    const result = await runMemoryImport({ client, cwd, yes: true, log: () => {} });
    expect(result).toEqual({ imported: false, reason: 'nothing-found' });
  });
});
