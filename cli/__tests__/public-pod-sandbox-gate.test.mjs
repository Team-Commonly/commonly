/**
 * #771 — attaching to a public pod without a sandbox declaration must fail.
 *
 * The public-agent sandbox is deny-by-default and attack-tested, but it only
 * engages once `sandbox.trust` and `sandbox.mode` are declared. `sandbox.mode`
 * defaults to `'none'`, and nothing connected "this pod is public" to "this
 * agent must be confined" — so an agent attached with no sandbox block ran
 * unconfined, silently.
 *
 * `hq-support` ran that way in a 67-member public pod until 2026-07-27. Its
 * permission deny-list was doing the file-blocking work; the OS-level sandbox
 * never engaged. Deny-by-default only means something if ABSENT is refused.
 */
import { jest } from '@jest/globals';
import { assertSandboxDeclaredForPublicPod } from '../src/commands/agent.js';

const clientFor = (pod) => ({ get: jest.fn().mockResolvedValue(pod) });

const PUBLIC_POD = { _id: 'p1', name: 'Commonly HQ', publicRead: true };
const PRIVATE_POD = { _id: 'p2', name: 'My Workspace', publicRead: false };
const SANDBOXED = { sandbox: { trust: 'public', mode: 'read-only' } };

describe('public-pod sandbox gate', () => {
  test('refuses a public pod when no sandbox is declared at all', async () => {
    // The exact hq-support shape: an environment with mcp/skills but no
    // `sandbox` key whatsoever.
    const environment = { version: 1, mcp: [], skills: {} };

    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(PUBLIC_POD), podId: 'p1', environment,
    })).rejects.toThrow(/publicly readable/i);
  });

  test('refuses when there is no environment file at all', async () => {
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(PUBLIC_POD), podId: 'p1', environment: null,
    })).rejects.toThrow(/no sandbox/i);
  });

  test('refuses when sandbox.mode is explicitly none', async () => {
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(PUBLIC_POD),
      podId: 'p1',
      environment: { sandbox: { trust: 'public', mode: 'none' } },
    })).rejects.toThrow(/publicly readable/i);
  });

  test('refuses a communityListed pod even when publicRead is false', async () => {
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor({ _id: 'p3', name: 'Bug Reports', communityListed: true }),
      podId: 'p3',
      environment: {},
    })).rejects.toThrow(/publicly readable/i);
  });

  test('the error tells the operator exactly what to add', async () => {
    // A refusal that does not say how to proceed just gets worked around.
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(PUBLIC_POD), podId: 'p1', environment: {},
    })).rejects.toThrow(/"trust": "public"/);
  });

  test('allows a public pod once a sandbox IS declared', async () => {
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(PUBLIC_POD), podId: 'p1', environment: SANDBOXED,
    })).resolves.toBeUndefined();
  });

  test('leaves private pods alone — this gate is only about public exposure', async () => {
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(PRIVATE_POD), podId: 'p2', environment: null,
    })).resolves.toBeUndefined();
  });

  test('does not query the pod at all when a sandbox is already declared', async () => {
    const client = clientFor(PUBLIC_POD);
    await assertSandboxDeclaredForPublicPod({
      client, podId: 'p1', environment: SANDBOXED,
    });
    expect(client.get).not.toHaveBeenCalled();
  });

  test('an unreadable pod warns and proceeds rather than failing the attach', async () => {
    // Failing attach on an unrelated network fault would be its own footgun —
    // but a SILENT skip is how the original hole stayed invisible, so it warns.
    const log = jest.fn();
    const client = { get: jest.fn().mockRejectedValue(new Error('403')) };

    await expect(assertSandboxDeclaredForPublicPod({
      client, podId: 'p1', environment: null, log,
    })).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not read pod visibility/i));
  });
});
