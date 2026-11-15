/**
 * Refuse before open (F535): a sandbox option the adapter can't enforce fails
 * the seat at start, naming the option and the adapter, instead of running
 * with it dropped.
 */
import { sandboxOptionRefusal } from '../src/lib/sandbox-option-refusal.js';

const env = (sandbox) => ({ sandbox });

describe('options no adapter enforces are refused', () => {
  test.each(['claude', 'codex', 'opencode', 'qwen', 'goose', 'pi', 'hermes'])('network.allow-hosts on an open network on %s', (adapter) => {
    const refusal = sandboxOptionRefusal(
      env({ trust: 'public', network: { policy: 'unrestricted', 'allow-hosts': ['api.example.com'] } }), adapter, 'linux',
    );
    expect(refusal).toContain('sandbox.network.allow-hosts');
    expect(refusal).toContain(adapter);
  });
});

describe('a restricted network under macOS Seatbelt', () => {
  test.each([
    ['claude', { trust: 'workspace' }],
    ['claude', { trust: 'public', mode: 'read-only' }],
    ['opencode', { trust: 'public' }],
    ['qwen', { trust: 'public', mode: 'workspace' }],
  ])('is refused on %s %j', (adapter, sandbox) => {
    const refusal = sandboxOptionRefusal(env({ ...sandbox, network: { policy: 'restricted' } }), adapter, 'darwin');
    expect(refusal).toContain(`The ${adapter} adapter can't restrict the network under macOS Seatbelt`);
  });

  test('is left to the adapter under bwrap, where claude and qwen refuse it and opencode applies it', () => {
    for (const adapter of ['claude', 'opencode', 'qwen']) {
      expect(sandboxOptionRefusal(env({ trust: 'public', network: { policy: 'restricted' } }), adapter, 'linux')).toBeNull();
    }
  });

  test('is accepted where the adapter enforces it (codex profile, dsh shape)', () => {
    expect(sandboxOptionRefusal(env({ trust: 'public', network: { policy: 'restricted' } }), 'codex', 'darwin')).toBeNull();
    expect(sandboxOptionRefusal(env({ mode: 'workspace', network: { policy: 'restricted' } }), 'dsh', 'darwin')).toBeNull();
  });
});

describe('a sandbox mode with no confined trust', () => {
  test.each([
    ['claude', 'workspace'],
    ['claude', 'read-only'],
    ['opencode', 'workspace'],
    ['qwen', 'bwrap'],
    ['goose', 'workspace'],
  ])('is refused on %s mode %s, which would spawn bare', (adapter, mode) => {
    expect(sandboxOptionRefusal(env({ mode }), adapter, 'darwin'))
      .toContain(`The ${adapter} adapter applies sandbox.mode=${mode} only with sandbox.trust=public`);
  });

  test('codex keeps mode workspace, its private profile, and refuses what that profile does not apply', () => {
    expect(sandboxOptionRefusal(env({ mode: 'read-only' }), 'codex', 'darwin'))
      .toContain('so sandbox.mode=read-only would not apply');
    expect(sandboxOptionRefusal(env({ mode: 'workspace', network: { policy: 'restricted' } }), 'codex', 'darwin'))
      .toContain("not applied by the codex adapter's private profile");
    expect(sandboxOptionRefusal(env({ mode: 'workspace', filesystem: { 'read-outside': ['~/notes'] } }), 'codex', 'darwin'))
      .toContain("sandbox.filesystem is not applied by the codex adapter's private profile");
  });

  test('is kept where the adapter gives it meaning: claude bwrap, codex profile, mode none', () => {
    expect(sandboxOptionRefusal(env({ mode: 'bwrap' }), 'claude', 'linux')).toBeNull();
    expect(sandboxOptionRefusal(env({ mode: 'workspace' }), 'codex', 'darwin')).toBeNull();
    expect(sandboxOptionRefusal(env({ mode: 'none' }), 'claude', 'darwin')).toBeNull();
  });
});

describe('network or filesystem rules on a seat with no sandbox', () => {
  test.each(['claude', 'codex', 'opencode', 'goose'])('are refused on %s', (adapter) => {
    expect(sandboxOptionRefusal(env({ network: { policy: 'restricted' } }), adapter, 'darwin'))
      .toContain(`sandbox.network is enforced only inside a sandbox, and this ${adapter} seat has none`);
    expect(sandboxOptionRefusal(env({ mode: 'none', filesystem: { 'read-outside': ['~/notes'] } }), adapter, 'darwin'))
      .toContain('sandbox.filesystem is enforced only inside a sandbox');
  });
});

describe('shapes that run today are untouched', () => {
  test.each([
    // docs/DEMO_QUICKSTART.md's macOS shape: an open network asks for nothing.
    ['the quickstart no-sandbox shape', 'claude', { mode: 'none', network: { policy: 'unrestricted' } }],
    ['empty filesystem lists', 'claude', { filesystem: { 'read-outside': [], 'write-outside': [] } }],
    // examples/demo/demo.yaml: bwrap with a restricted network reaches no host,
    // so its allow-hosts asks for less than it gets.
    ['the demo env', 'claude', {
      mode: 'bwrap', network: { policy: 'restricted', 'allow-hosts': ['localhost', 'github.com'] },
      filesystem: { 'write-outside': [] },
    }],
    ['allow-hosts beside a restricted public bwrap network', 'opencode', {
      trust: 'public', mode: 'bwrap', network: { policy: 'restricted', 'allow-hosts': ['github.com'] },
    }],
    ['no sandbox', 'claude', undefined],
    ['the default public seat', 'opencode', { trust: 'public' }],
    ['a public read-only opencode seat', 'opencode', { trust: 'public', mode: 'read-only' }],
    ['claude workspace trust with an allow list', 'claude', { trust: 'workspace', allow: ['write'] }],
    ['a legacy internal trust', 'claude', { trust: 'internal', mode: 'workspace' }],
    ['the test stub', 'stub', { mode: 'workspace', network: { 'allow-hosts': ['x'] } }],
  ])('%s', (_label, adapter, sandbox) => {
    expect(sandboxOptionRefusal(sandbox ? env(sandbox) : {}, adapter, 'darwin')).toBeNull();
  });
});
