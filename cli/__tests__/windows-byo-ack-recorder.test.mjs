// The walks' ack recorder (cli/scripts/windows-byo-ack-recorder.mjs) notes the
// class of each ack the CLI sends, so the verdict can tell a model refusal the
// CLI acked from a reply it posted (D250). It records labels only: never the
// result's free-text detail, the delivery id, a header or message content.
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('the walk\'s ack recorder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'byo-ack-recorder-'));
  const log = join(dir, 'acks.jsonl');
  const realFetch = globalThis.fetch;
  const previous = process.env.COMMONLY_BYO_ACK_LOG;

  beforeAll(async () => {
    process.env.COMMONLY_BYO_ACK_LOG = log;
    globalThis.fetch = async () => new Response('{"success":true}', { status: 200 });
    await import('../scripts/windows-byo-ack-recorder.mjs');
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.COMMONLY_BYO_ACK_LOG;
    else process.env.COMMONLY_BYO_ACK_LOG = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  test('an ack is recorded with its outcome, reason and refused status, and nothing else from its body', async () => {
    await globalThis.fetch('https://api.example/api/agents/runtime/events/e1/ack', {
      method: 'POST',
      headers: { authorization: 'Bearer cm_agent_secret' },
      body: JSON.stringify({
        result: {
          outcome: 'no_action',
          reason: 'upstream-refused-401',
          refused: { reason: 'upstream-refused', status: 401 },
          details: { status: 401, detail: 'invalid key sk-gateway-secret' },
        },
        deliveryId: 'delivery-secret',
      }),
    });
    const text = readFileSync(log, 'utf8');
    const [row] = text.trim().split('\n').map((line) => JSON.parse(line));
    expect(row).toEqual({
      at: expect.any(String), kind: 'ack', eventId: 'e1', status: 200,
      outcome: 'no_action', reason: 'upstream-refused-401', refusedStatus: 401,
    });
    expect(text).not.toMatch(/sk-gateway-secret|delivery-secret|cm_agent_secret/);
  });

  const rows = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  // The label filter is what keeps free text out: a reason or outcome that is
  // not a bare label is dropped, never copied.
  test('a reason or outcome in free text is dropped, so a secret inside it never reaches the log', async () => {
    await globalThis.fetch('https://api.example/api/agents/runtime/events/e2/ack', {
      method: 'POST',
      body: JSON.stringify({ result: { outcome: 'no action taken', reason: 'invalid key sk-free-text-secret' } }),
    });
    expect(rows().find((row) => row.eventId === 'e2')).toEqual({ at: expect.any(String), kind: 'ack', eventId: 'e2', status: 200 });
    expect(readFileSync(log, 'utf8')).not.toContain('sk-free-text-secret');
  });

  test('an ack whose body is not JSON is recorded with its event and status only, and the call goes through', async () => {
    const res = await globalThis.fetch('https://api.example/api/agents/runtime/events/e3/ack', {
      method: 'POST', body: 'not json sk-raw-body-secret',
    });
    expect(res.status).toBe(200);
    expect(rows().find((row) => row.eventId === 'e3')).toEqual({ at: expect.any(String), kind: 'ack', eventId: 'e3', status: 200 });
    expect(readFileSync(log, 'utf8')).not.toContain('sk-raw-body-secret');
  });
});
