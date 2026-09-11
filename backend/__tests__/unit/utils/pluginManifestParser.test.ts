// @ts-nocheck

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  parsePluginManifest,
  PluginManifestValidationError,
} from '../../../utils/pluginManifestParser';

const sha = '0123456789abcdef0123456789abcdef01234567';

const writeManifest = (root: string, directory: string, manifest: unknown) => {
  const pluginDirectory = path.join(root, directory);
  fs.mkdirSync(pluginDirectory, { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'plugin.json'), JSON.stringify(manifest));
};

const validManifest = (overrides: Record<string, unknown> = {}) => ({
  name: 'calendar-tools',
  description: 'Calendar tools',
  version: '1.2.3',
  source: { spec: 'acme/calendar-tools', subpath: 'servers/calendar', pin: sha },
  mcpServers: {
    calendar: {
      transport: 'stdio',
      command: ['node', 'server.js'],
      variables: {
        account: { type: 'string', default: 'work' },
        token: { type: 'string', writeOnly: true },
      },
      enabledTools: ['events.read', 'events.read'],
    },
  },
  ...overrides,
});

const makeRoot = (manifest: unknown, directory = '.claude-plugin') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commonly-plugin-'));
  writeManifest(root, directory, manifest);
  return root;
};

describe('plugin manifest parser', () => {
  it('maps a local Claude root to an Installable with MCP components', () => {
    const result = parsePluginManifest(makeRoot(validManifest()));

    expect(result).toMatchObject({
      installableId: 'calendar-tools',
      name: 'calendar-tools',
      kind: 'app',
      source: 'user',
      scope: 'user',
      components: [{
        name: 'calendar',
        type: 'mcp-server',
        transport: 'stdio',
        source: { spec: 'acme/calendar-tools', subpath: 'servers/calendar', pin: sha },
        command: ['node', 'server.js'],
        enabledTools: ['events.read'],
      }],
    });
  });

  it('accepts both plugin roots and lets Claude values win while Cursor fills gaps', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commonly-plugin-'));
    writeManifest(root, '.claude-plugin', {
      name: 'dual-root',
      description: 'Claude description',
      version: '1.0.0',
      source: 'acme/dual-root',
      mcpServers: {
        one: { transport: 'stdio', command: ['node', 'one.js'] },
      },
    });
    writeManifest(root, '.cursor-plugin', {
      name: 'cursor-name-must-not-win',
      description: 'Cursor description',
      version: '9.9.9',
      source: 'acme/cursor-root',
      mcpServers: {
        one: { enabledTools: ['one.read'] },
        two: { transport: 'http', url: 'https://example.com/mcp', source: 'acme/two' },
      },
    });

    const result = parsePluginManifest(root);
    expect(result.name).toBe('dual-root');
    expect(result.version).toBe('1.0.0');
    expect(result.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'one', command: ['node', 'one.js'], enabledTools: ['one.read'] }),
      expect.objectContaining({ name: 'two', transport: 'http' }),
    ]));
  });

  it.each([
    ['file:///tmp/secret', 'Only https://github.com'],
    ['ssh://git@github.com/acme/plugin', 'Only https://github.com'],
    ['https://internal.example/acme/plugin', 'Only https://github.com'],
  ])('rejects disallowed source %s before any fetch', (spec, message) => {
    const root = makeRoot(validManifest({ source: { spec } }));
    expect(() => parsePluginManifest(root)).toThrow(message);
  });

  it('rejects absolute and traversal subpaths', () => {
    for (const subpath of ['/etc/passwd', '../outside', 'servers/../../outside', 'servers/%2e%2e/outside']) {
      const root = makeRoot(validManifest({ source: { spec: 'acme/plugin', subpath } }));
      expect(() => parsePluginManifest(root)).toThrow(PluginManifestValidationError);
    }
    const traversalSource = makeRoot(validManifest({ source: { spec: '../outside' } }));
    expect(() => parsePluginManifest(traversalSource)).toThrow(PluginManifestValidationError);
  });

  it('rejects non-40-character pins and preserves a valid pin verbatim', () => {
    const badRoot = makeRoot(validManifest({ source: { spec: 'acme/plugin', pin: 'abc' } }));
    expect(() => parsePluginManifest(badRoot)).toThrow('40-character commit SHA');

    const goodPin = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
    const result = parsePluginManifest(makeRoot(validManifest({ source: { spec: 'acme/plugin', pin: goodPin } })));
    expect(result.components[0].source?.pin).toBe(goodPin);
  });

  it('canonicalizes an allowed GitHub URL and local source path', () => {
    const github = parsePluginManifest(makeRoot(validManifest({
      source: { spec: 'https://github.com/acme/plugin/' },
    })));
    expect(github.components[0].source?.spec).toBe('https://github.com/acme/plugin');

    const local = parsePluginManifest(makeRoot(validManifest({
      source: { spec: './servers//calendar' },
    })));
    expect(local.components[0].source?.spec).toBe('servers/calendar');
  });

  it('accepts a string source with sibling subpath and pin fields', () => {
    const result = parsePluginManifest(makeRoot(validManifest({
      source: 'https://github.com/acme/plugin',
      subpath: './servers/calendar',
      pin: sha,
    })));
    expect(result.components[0].source).toEqual({
      spec: 'https://github.com/acme/plugin',
      subpath: 'servers/calendar',
      pin: sha,
    });
  });

  it('infers transport for standard command/url MCP manifest entries', () => {
    const root = makeRoot(validManifest({
      mcpServers: {
        calendar: {
          command: 'npx',
          args: ['-y', '@acme/calendar-mcp'],
          source: 'acme/calendar',
        },
        remote: {
          url: 'https://mcp.example.test/server',
          source: 'acme/calendar',
        },
      },
    }));
    const result = parsePluginManifest(root);
    expect(result.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'calendar', transport: 'stdio', command: ['npx', '-y', '@acme/calendar-mcp'] }),
      expect.objectContaining({ name: 'remote', transport: 'http' }),
    ]));
  });

  it('refuses a writeOnly literal default with the variable name', () => {
    const root = makeRoot(validManifest({
      mcpServers: {
        calendar: {
          transport: 'stdio',
          command: ['node', 'server.js'],
          variables: { token: { type: 'string', writeOnly: true, default: 'secret' } },
        },
      },
    }));
    expect(() => parsePluginManifest(root)).toThrow('manifest.mcpServers.calendar.variables.token');
  });

  it('refuses provider-specific literal fields on writeOnly variables', () => {
    const root = makeRoot(validManifest({
      mcpServers: {
        calendar: {
          transport: 'stdio',
          command: ['node', 'server.js'],
          variables: { token: { type: 'string', writeOnly: true, value: 'secret' } },
        },
      },
    }));
    expect(() => parsePluginManifest(root)).toThrow('literal value');
  });

  it('refuses a writeOnly literal env value but permits a secret reference', () => {
    const literalRoot = makeRoot(validManifest({
      mcpServers: {
        calendar: {
          transport: 'stdio',
          command: ['node', 'server.js'],
          variables: { token: { type: 'string', writeOnly: true } },
          env: { token: 'secret' },
        },
      },
    }));
    expect(() => parsePluginManifest(literalRoot)).toThrow('writeOnly variable must use a secret reference');

    const referenceRoot = makeRoot(validManifest({
      mcpServers: {
        calendar: {
          transport: 'stdio',
          command: ['node', 'server.js'],
          variables: { token: { type: 'string', writeOnly: true } },
          env: { token: { secretRef: 'connections/calendar/token' } },
        },
      },
    }));
    expect(() => parsePluginManifest(referenceRoot)).not.toThrow();
  });

  it('maps local skill entries and marks a skills-only plugin as kind skill', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commonly-plugin-'));
    fs.mkdirSync(path.join(root, 'skills', 'research'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'research', 'SKILL.md'), '# Research\nUse primary sources.');
    writeManifest(root, '.cursor-plugin', {
      name: 'research-skills',
      description: 'Research skills',
      version: '1.0.0',
      skills: [{ path: 'skills/research' }],
    });

    const result = parsePluginManifest(root);
    expect(result.kind).toBe('skill');
    expect(result.components).toEqual([expect.objectContaining({
      type: 'skill',
      skillId: 'research',
      skillPrompt: '# Research\nUse primary sources.',
    })]);
  });
});
