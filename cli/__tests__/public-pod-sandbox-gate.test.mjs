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
const PRIVATE_POD = {
  _id: 'p2', name: 'My Workspace', publicRead: false, communityListed: false, joinPolicy: 'invite-only',
};
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

  test('accepts a legacy `internal` record, which means public here too', async () => {
    // `internal` is read as `public` by the attach
    // gate and by both adapters, so a raw compare here refused a record that
    // means public one call before the gate TASK-113 fixes — the row's claim
    // would be false with this path still throwing. No pod read: a declared
    // sandbox short-circuits before the client is touched.
    const client = clientFor(PUBLIC_POD);
    await expect(assertSandboxDeclaredForPublicPod({
      client, podId: 'p1', environment: { sandbox: { trust: 'internal' } },
    })).resolves.toBeUndefined();
    expect(client.get).not.toHaveBeenCalled();
  });

  test('still refuses a legacy `internal` record that declares mode none', async () => {
    // The mapping changes what `internal` MEANS, not whether `none` counts as
    // confinement: resolved through the table this is the public+none shape the
    // test above already refuses.
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(PUBLIC_POD),
      podId: 'p1',
      environment: { sandbox: { trust: 'internal', mode: 'none' } },
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

  test('allows the derived mode-less public declaration — the daemon\'s own shape', async () => {
    // lib/default-environment.js writes `sandbox: { trust: 'public' }` with no
    // mode, because the mode is a host fact the adapters resolve at spawn. The
    // gate refusing that shape would make the daemon's own baseline
    // unattachable to a public pod.
    const client = clientFor(PUBLIC_POD);
    await expect(assertSandboxDeclaredForPublicPod({
      client, podId: 'p1', environment: { sandbox: { trust: 'public' } },
    })).resolves.toBeUndefined();
    expect(client.get).not.toHaveBeenCalled();
  });

  test('allows claude bwrap without a trust field — that IS confinement', async () => {
    // The old predicate required trust AND mode, so a genuinely confined
    // `mode: 'bwrap'` seat was refused on a public pod. claude wraps the spawn
    // in bwrap whatever the trust says, and attach separately checks it is installed.
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(PUBLIC_POD), podId: 'p1', adapterName: 'claude', environment: { sandbox: { mode: 'bwrap' } },
    })).resolves.toBeUndefined();
  });

  test('refuses codex bwrap without a trust field: codex applies a mode only under a public trust', async () => {
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(PUBLIC_POD), podId: 'p1', adapterName: 'codex', environment: { sandbox: { mode: 'bwrap' } },
    })).rejects.toThrow(/publicly readable/);
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

  // A seat with no sandbox runs with its owner's access, so the pod must be
  // confirmed private: an unreadable pod, one open to join and one that does
  // not report its visibility all fail closed (lib/unconfined-seat-guard.js).
  test('an unreadable pod refuses an agent with no sandbox, and says how to retry', async () => {
    const client = { get: jest.fn().mockRejectedValue(new Error('403')) };
    await expect(assertSandboxDeclaredForPublicPod({ client, podId: 'p1', environment: null }))
      .rejects.toThrow(/visibility could not be read.*confirmed private and invite-only/s);
  });

  test.each([
    ['open to join', { name: 'Open pod', publicRead: false, communityListed: false, joinPolicy: 'open' }, /"Open pod" is open to join/],
    ['open by default (no joinPolicy)', { name: 'Old pod', publicRead: false, communityListed: false }, /"Old pod" is open to join/],
    ['invite-only but silent on visibility', { name: 'Quiet pod', joinPolicy: 'invite-only' }, /"Quiet pod" did not report whether it is publicly readable/],
  ])('a pod %s refuses an agent with no sandbox', async (_label, pod, message) => {
    await expect(assertSandboxDeclaredForPublicPod({ client: clientFor(pod), podId: 'p3', environment: null }))
      .rejects.toThrow(message);
    await expect(assertSandboxDeclaredForPublicPod({ client: clientFor(pod), podId: 'p3', environment: null }))
      .rejects.toThrow(/anyone who joins could direct it with your own access/);
  });

  // A mode with no trust is spawned bare by claude and codex, so it is no
  // sandbox here either.
  test.each(['claude', 'codex'])('a %s seat with a sandbox mode but no trust needs a private pod', async (adapterName) => {
    const pod = { name: 'Open pod', publicRead: false, communityListed: false, joinPolicy: 'open' };
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(pod), podId: 'p3', adapterName, environment: { sandbox: { mode: 'read-only' } },
    })).rejects.toThrow(/"Open pod" is open to join/);
  });

  test('the same pod admits the agent once it declares a sandbox', async () => {
    const pod = { name: 'Open pod', publicRead: false, communityListed: false, joinPolicy: 'open' };
    await expect(assertSandboxDeclaredForPublicPod({ client: clientFor(pod), podId: 'p3', environment: SANDBOXED }))
      .resolves.toBeUndefined();
  });
});

// A `workspace` seat lets the room read its start directory (TASK-294), so the
// gate needs the pod CONFIRMED private and fails closed on anything less.
describe('workspace trust needs a confirmed private pod', () => {
  const WORKSPACE = { sandbox: { trust: 'workspace' } };
  const CONFIRMED_PRIVATE = {
    _id: 'p2', name: 'My Workspace', publicRead: false, communityListed: false, joinPolicy: 'invite-only',
  };

  test('accepts a pod that reports itself private and invite-only', async () => {
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor(CONFIRMED_PRIVATE), podId: 'p2', environment: WORKSPACE,
    })).resolves.toBeUndefined();
  });

  test('refuses a publicly readable pod', async () => {
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor({ ...PUBLIC_POD, communityListed: false }), podId: 'p1', environment: WORKSPACE,
    })).rejects.toThrow(/"Commonly HQ" is publicly readable, so sandbox\.trust=workspace/);
  });

  // Any agent can add itself to an open pod an agent created, listed or not.
  test('refuses a private pod that is open to join', async () => {
    const { joinPolicy: _policy, ...unstated } = CONFIRMED_PRIVATE;
    for (const pod of [{ ...CONFIRMED_PRIVATE, joinPolicy: 'open' }, unstated]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(assertSandboxDeclaredForPublicPod({
        client: clientFor(pod), podId: 'p2', environment: WORKSPACE,
      })).rejects.toThrow(/"My Workspace" is open to join, .* attach to a private, invite-only pod/);
    }
  });

  test('refuses a pod that does not report both fields, rather than guessing private', async () => {
    await expect(assertSandboxDeclaredForPublicPod({
      client: clientFor({ _id: 'p2', name: 'My Workspace', publicRead: false }), podId: 'p2', environment: WORKSPACE,
    })).rejects.toThrow(/did not report its visibility/);
  });

  test('refuses when the visibility read fails, where a public declaration only warns', async () => {
    const client = { get: jest.fn().mockRejectedValue(new Error('offline')) };
    await expect(assertSandboxDeclaredForPublicPod({
      client, podId: 'p2', environment: WORKSPACE,
    })).rejects.toThrow(/requires confirmed private pod visibility/);
  });
});
