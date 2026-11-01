/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
const { appendEntry, verifyRecord } = require('../../../vendor/seats/src/record/format');
const { toOtlpJson } = require('../../../vendor/seats/src/record/otel');
const lines = require('../../../services/brokerRecordLines');

const POD = '6a692a1be833c668acdb84cf';
const AGENT = { type: 'agent', id: '6a920d43b08dee6c42a81c9e', owner: '6a47891ee025ce2e0ca1d30b' };
const OWNER = '6a47891ee025ce2e0ca1d30b';
const CALL = { toolCallId: 'tool_call_1', tool: 'sentry.resolve_issue', grantId: 'grant_abc', agent: AGENT };

// Every line goes through the shared writer, so a field the format refuses fails here.
const write = (inputs) => {
  let prev = null;
  const out = inputs.map((input, index) => {
    prev = appendEntry(prev, {
      runId: 'srv-pod-0123456789abcdef', podId: POD, ts: `2026-10-26T05:00:${String(index).padStart(2, '0')}.000Z`,
      kind: input.kind, ...(input.actor === undefined ? {} : { actor: input.actor }), data: input.data,
    });
    return prev;
  });
  return out.map((line) => `${line}\n`).join('');
};
const parse = (jsonl) => jsonl.trimEnd().split('\n').map((line) => JSON.parse(line));

describe('ADR-033 B1–B5 broker lines', () => {
  it('B1 refused: asked of the grant policy, denied, failed', () => {
    const entries = parse(write(lines.refusedCallLines(CALL)));
    expect(entries.map((e) => e.kind)).toEqual(['tool.call', 'permission.requested', 'permission.decided', 'tool.update']);
    expect(entries[0]).toMatchObject({ actor: AGENT, data: { toolCallId: 'tool_call_1', title: CALL.tool, name: CALL.tool, surface: 'connector' } });
    expect(entries[1].data).toMatchObject({ askedOf: { id: 'grant:grant_abc', role: 'policy' }, question: CALL.tool, grantId: 'grant_abc' });
    expect(entries[1].data.options).toEqual([{ optionId: 'approve', kind: 'allow_once' }, { optionId: 'decline', kind: 'reject_once' }]);
    expect(entries[2]).toMatchObject({
      actor: { type: 'policy', id: 'grant:grant_abc' },
      data: { optionId: 'decline', kind: 'reject_once', rule: { list: 'deny', pattern: null }, decidedBy: 'policy', decidedByRole: 'policy' },
    });
    expect(entries[2].data.approval).toBeUndefined();
    expect(entries[3].data).toEqual({ toolCallId: 'tool_call_1', status: 'failed' });
  });

  it('B2 parked then B3 approved: asked of the credential owner, decided by them on the card', () => {
    const jsonl = write([
      ...lines.parkedCallLines(CALL, OWNER, 'approval_1'),
      ...lines.resolvedCallLines(CALL, true, OWNER, 'approval_1'),
      lines.toolUpdate(CALL, 'completed'),
    ]);
    const entries = parse(jsonl);
    expect(entries.map((e) => e.kind)).toEqual(['tool.call', 'permission.requested', 'permission.decided', 'tool.update']);
    expect(entries[1].data).toMatchObject({ askedOf: { id: OWNER, role: 'credential-owner' }, decisionCardId: 'approval_1' });
    expect(entries[2]).toMatchObject({
      actor: { type: 'human', id: OWNER },
      data: { optionId: 'approve', approval: 'approved', rule: { list: 'ask', pattern: null }, decidedBy: OWNER, decidedByRole: 'credential-owner', decisionCardId: 'approval_1' },
    });
    expect(entries[3].data.status).toBe('completed');
  });

  it('B3 declined writes the decision and a failed update in one event', () => {
    const entries = parse(write(lines.resolvedCallLines(CALL, false, OWNER)));
    expect(entries.map((e) => [e.kind, e.data.approval || e.data.status])).toEqual([
      ['permission.decided', 'rejected'], ['tool.update', 'failed'],
    ]);
  });

  it('B4 expired: the policy declines as timed out', () => {
    const entries = parse(write(lines.expiredCallLines(CALL, 'approval_1')));
    expect(entries[0]).toMatchObject({
      actor: { type: 'policy', id: 'grant:grant_abc' },
      data: { approval: 'timed_out', decidedBy: 'policy', decidedByRole: 'policy', decisionCardId: 'approval_1' },
    });
    expect(entries[1].data.status).toBe('failed');
  });

  it('B5 executed: allowed by the grant policy, completed or failed', () => {
    expect(parse(write(lines.executedCallLines(CALL, true))).map((e) => e.data.status || e.data.rule?.list))
      .toEqual([undefined, undefined, 'allow', 'completed']);
    expect(parse(write(lines.executedCallLines(CALL, false)))[3].data.status).toBe('failed');
  });

  it('carries no argsDigest on any line, in JSONL or OTLP (CTO launch rule)', () => {
    const jsonl = write([
      ...lines.refusedCallLines(CALL),
      ...lines.parkedCallLines({ ...CALL, toolCallId: 'tool_call_2' }, OWNER, 'approval_1'),
      ...lines.resolvedCallLines({ ...CALL, toolCallId: 'tool_call_2' }, true, OWNER, 'approval_1'),
      ...lines.expiredCallLines({ ...CALL, toolCallId: 'tool_call_3' }),
      ...lines.executedCallLines({ ...CALL, toolCallId: 'tool_call_4' }, true),
    ]);
    expect(verifyRecord(jsonl).ok).toBe(true);
    expect(jsonl).not.toMatch(/argsDigest|args_digest|sha256:/);
    expect(JSON.stringify(toOtlpJson(parse(jsonl), { serviceName: 'commonly' }))).not.toMatch(/args_digest|argsDigest|sha256:/);
  });

  it('refuses a credential-owner role from a pod member: the format allows pod-member only on decision.ruled', () => {
    const bad = lines.resolvedCallLines(CALL, true, OWNER)[0];
    bad.data.decidedByRole = 'pod-member';
    expect(() => write([bad])).toThrow(/record:/);
  });
});

describe('grant lines', () => {
  const grant = {
    grantId: 'grant_child', parentGrantId: 'grant_root', connectionId: 'conn_1', tools: ['sentry.resolve_issue'],
    writeMode: 'write-with-confirm', budget: { calls: 5 }, audience: [OWNER], target: { kind: 'pod', id: POD },
    expiresAt: new Date('2026-10-27T00:00:00.000Z'),
  };

  it('grant.issued names connection, exact tools, mode, budget, audience, target, issuer and expiry', () => {
    const [entry] = parse(write([lines.grantIssuedLine(grant, { type: 'human', id: OWNER })]));
    expect(entry).toMatchObject({
      actor: { type: 'human', id: OWNER },
      data: {
        grantId: 'grant_child', parentGrantId: 'grant_root',
        scope: { connectionId: 'conn_1', tools: ['sentry.resolve_issue'], writeMode: 'write-with-confirm', budget: { calls: 5 }, audience: [OWNER] },
        target: { kind: 'pod', id: POD }, issuedBy: OWNER, expiresAt: '2026-10-27T00:00:00.000Z',
      },
    });
  });

  it('an attenuating agent is the issuer, as an agent', () => {
    const [entry] = parse(write([lines.grantIssuedLine(grant, AGENT)]));
    expect(entry.actor).toEqual(AGENT);
    expect(entry.data.issuedBy).toBe(AGENT.id);
  });

  it('grant.revoked: cascade lists the ancestor first', () => {
    const [entry] = parse(write([lines.grantRevokedLine(['grant_root', 'grant_child'], 'cascade', { type: 'human', id: OWNER })]));
    expect(entry.data).toEqual({ grantIds: ['grant_root', 'grant_child'], reason: 'cascade' });
  });
});
