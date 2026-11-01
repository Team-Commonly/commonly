/**
 * `sandbox.trust: 'workspace'` is claude-only for now (TASK-294). Every other
 * adapter branches on `trust === 'public'`, so an unread `workspace` would land
 * in its non-public branch — for most of them an unconfined spawn. Each one has
 * to refuse the declaration before it reads anything else.
 */
import { describe, expect, test } from '@jest/globals';
import { refuseWorkspaceTrust } from '../src/lib/environment.js';
import codex from '../src/lib/adapters/codex.js';
import opencode from '../src/lib/adapters/opencode.js';
import qwen from '../src/lib/adapters/qwen.js';
import { assertPrivateDsh } from '../src/lib/adapters/dsh.js';
import { assertSandboxSupported as assertGooseUnsandboxed } from '../src/lib/adapters/goose.js';
import { assertNoSandboxDeclared as assertPiUnsandboxed } from '../src/lib/adapters/pi.js';

const workspaceEnv = { model: 'test-model', sandbox: { trust: 'workspace' } };
const CLAUDE_ONLY = /sandbox\.trust=workspace is claude-only for now/;

describe('refuseWorkspaceTrust', () => {
  test('passes every trust it does not own', () => {
    expect(() => refuseWorkspaceTrust(undefined, 'codex')).not.toThrow();
    expect(() => refuseWorkspaceTrust({}, 'codex')).not.toThrow();
    expect(() => refuseWorkspaceTrust({ trust: 'public' }, 'codex')).not.toThrow();
  });

  test('names the adapter and the way out', () => {
    expect(() => refuseWorkspaceTrust({ trust: 'workspace' }, 'codex'))
      .toThrow(/^codex adapter: sandbox\.trust=workspace is claude-only for now\. Declare sandbox\.trust 'public'/);
  });
});

describe('adapters that do not implement the workspace tier refuse it', () => {
  test.each([
    ['codex', codex],
    ['opencode', opencode],
    ['qwen', qwen],
  ])('%s refuses at spawn, before it starts a process', async (name, adapter) => {
    await expect(adapter.spawn('hello', { environment: workspaceEnv }))
      .rejects.toThrow(new RegExp(`^${name} adapter: sandbox\\.trust=workspace is claude-only`));
  });

  test.each([
    ['dsh', assertPrivateDsh],
    ['goose', assertGooseUnsandboxed],
    ['pi', assertPiUnsandboxed],
  ])('%s refuses in its sandbox assertion', (name, assertSandbox) => {
    expect(() => assertSandbox(workspaceEnv)).toThrow(CLAUDE_ONLY);
    expect(() => assertSandbox(workspaceEnv)).toThrow(new RegExp(`^${name} adapter:`));
  });
});
