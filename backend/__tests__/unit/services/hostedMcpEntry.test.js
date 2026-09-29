// TASK-172 slice 2: the catalogue entry, its projection and drift
// (docs/plans/hosted-mcp-connection-scope.md §3). Every arm here is the
// entry-owned half of the decision; nothing in this file reaches a vendor or a
// database, which is what lets the slice land before §4's intake.
const {
  assessEntryTools,
  canonicalJson,
  createHostedMcpDriftCache,
  entryToolProjections,
  hostedMcpToolName,
} = require('../../../services/hostedMcpEntryService');
const {
  HOSTED_MCP_ENTRIES,
  assertHostedMcpEntries,
  findHostedMcpEntry,
} = require('../../../integrations/hostedMcp/entries');

const ENTRY_TEXT = 'ENTRY TEXT the pin agreed to.';
const VENDOR_TEXT = 'VENDOR TEXT nobody reviewed.';

const pinned = (over) => Object.assign({
  name: 'list_issues',
  upstreamName: 'list_issues',
  description: ENTRY_TEXT,
  class: 'read',
  inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
  annotations: { readOnlyHint: true },
}, over);

const linear = (over) => Object.assign({
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read', 'openid'],
  revoke: 'https://mcp.linear.app/token',
  tools: [
    pinned({}),
    pinned({
      // Renamed by us: the entry's local name is what an agent sees, and the
      // vendor's list is read under `upstreamName`.
      name: 'read_issue',
      upstreamName: 'get_issue',
      description: 'Read one issue.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    }),
  ],
}, over);

// The vendor's list, carrying the vendor's own wording for a tool we pinned.
const upstreamOk = () => ([
  {
    name: 'list_issues',
    description: VENDOR_TEXT,
    inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_issue',
    description: VENDOR_TEXT,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
]);

const verdictOf = (assessments, name) => assessments.find((a) => a.name === name).verdict;

describe('a catalogue entry projects only what it pinned', () => {
  test('an upstream tool not in the entry is never offered', () => {
    const entry = linear();
    const upstream = upstreamOk().concat([{
      name: 'create_issue',
      description: VENDOR_TEXT,
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    }]);

    // Control: the fixture really does carry the unpublished tool and a vendor
    // list that the entry's pins all match, so the absences below are absences.
    expect(upstream.some((tool) => tool.name === 'create_issue')).toBe(true);
    expect(assessEntryTools(entry, upstream).every((a) => a.verdict === 'ok')).toBe(true);

    const offered = entryToolProjections(entry).map((definition) => definition.name);
    expect(offered).toEqual(['linear.list_issues', 'linear.read_issue']);
    expect(offered).not.toContain('linear.create_issue');
    expect(assessEntryTools(entry, upstream).map((a) => a.namespacedName))
      .not.toContain('linear.create_issue');

    // The projection carries the entry it came from, because a grant stores
    // this name and a trail row has to name the entry that refused it.
    const [first] = entryToolProjections(entry);
    expect(first.connectionType).toBe('hosted-mcp');
    expect(first.entryId).toBe('linear');
  });

  test('the upstream description never reaches an agent', () => {
    const entry = linear();
    const upstream = upstreamOk();
    const definitions = entryToolProjections(entry);

    // Control: the search finds text in this structure when it is there.
    expect(JSON.stringify(definitions)).toContain(ENTRY_TEXT);
    expect(JSON.stringify(definitions)).not.toContain(VENDOR_TEXT);
    expect(definitions.find((d) => d.name === 'linear.list_issues').description).toBe(ENTRY_TEXT);
    // A refusal detail is trail text another person reads, so it is ours too.
    expect(JSON.stringify(assessEntryTools(entry, upstream))).not.toContain(VENDOR_TEXT);
  });

  test('a write is pinned as a parking write mode, and irreversible adds a park', () => {
    const entry = linear({
      tools: [
        pinned({
          name: 'create_issue',
          class: 'write',
          irreversible: true,
        }),
      ],
    });
    const [definition] = entryToolProjections(entry);
    expect(definition.requiredWriteMode).toBe('write-with-confirm');
    expect(definition.irreversible).toBe(true);
    expect(entryToolProjections(linear())[0].requiredWriteMode).toBe('read');
  });
});

describe('drift is a named refusal', () => {
  test('a duplicated upstream name resolves first-wins', () => {
    const entry = linear({ tools: [pinned({})] });
    const upstream = [
      { name: 'list_issues', inputSchema: pinned({}).inputSchema, annotations: { readOnlyHint: true } },
      { name: 'list_issues', inputSchema: { type: 'object' }, annotations: {} },
    ];
    expect(verdictOf(assessEntryTools(entry, upstream), 'list_issues')).toBe('ok');
  });

  test('a pinned tool missing upstream is refused tool_unavailable', () => {
    const entry = linear();
    const upstream = upstreamOk().filter((tool) => tool.name !== 'get_issue');
    const assessment = assessEntryTools(entry, upstream).find((a) => a.name === 'read_issue');

    expect(assessment.verdict).toBe('tool_unavailable');
    expect(assessment.namespacedName).toBe('linear.read_issue');
    // The refusal names the UPSTREAM tool, which is the one that is gone.
    expect(assessment.detail).toContain('get_issue');

    // Acceptance control: present and unchanged is offered, so the refusal
    // above is about the absence and not about every tool in the entry.
    expect(verdictOf(assessEntryTools(entry, upstreamOk()), 'read_issue')).toBe('ok');
  });

  test('a pinned tool whose schema changed upstream is refused tool_drift', () => {
    const entry = linear();
    const widened = upstreamOk();
    widened[0] = Object.assign({}, widened[0], {
      inputSchema: { type: 'object', properties: { team: { type: 'string' }, limit: { type: 'number' } } },
    });
    const assessment = assessEntryTools(entry, widened).find((a) => a.name === 'list_issues');

    expect(assessment.verdict).toBe('tool_drift');
    expect(assessment.detail).toContain('inputSchema');

    // Acceptance control: key ORDER is not schema. This is what a plain
    // JSON.stringify comparison would have called drift.
    const reordered = upstreamOk();
    reordered[0] = Object.assign({}, reordered[0], {
      inputSchema: { properties: { team: { type: 'string' } }, type: 'object' },
    });
    expect(verdictOf(assessEntryTools(entry, reordered), 'list_issues')).toBe('ok');
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    // Exact spellings, so a canonicalizer that flattened arrays into keyed
    // objects (a plausible wrong fix for the ordering rule) is caught here and
    // not by a comparison that two wrong spellings could still satisfy.
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson(['a', 'b'])).toBe('["a","b"]');
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
    // Array order IS schema, unlike key order.
    expect(canonicalJson(['a', 'b'])).not.toBe(canonicalJson(['b', 'a']));
    // A spelling for the absent value, so two absent schemas compare equal
    // rather than comparing `undefined`.
    expect(canonicalJson(undefined)).toBe('undefined');
  });

  test('an annotation that moved toward write is drift; one that tightened is not', () => {
    const entry = linear();

    const withdrawn = upstreamOk();
    withdrawn[0] = Object.assign({}, withdrawn[0], { annotations: {} });
    expect(verdictOf(assessEntryTools(entry, withdrawn), 'list_issues')).toBe('tool_drift');

    const destructive = upstreamOk();
    destructive[0] = Object.assign({}, destructive[0], { annotations: { destructiveHint: true } });
    expect(verdictOf(assessEntryTools(entry, destructive), 'list_issues')).toBe('tool_drift');

    // Acceptance control: a tool that gains readOnlyHint, or loses
    // destructiveHint, is claiming less than it did, not more.
    const tightened = linear({
      tools: [pinned({
        annotations: { destructiveHint: true },
        inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
      })],
    });
    expect(verdictOf(assessEntryTools(tightened, upstreamOk()), 'list_issues')).toBe('ok');

    // A pin that carries no annotations at all is still compared, and the
    // vendor setting one is drift.
    const unpinned = upstreamOk();
    unpinned[0] = Object.assign({}, unpinned[0], { annotations: { destructiveHint: true } });
    expect(verdictOf(assessEntryTools(linear({ tools: [pinned({ annotations: undefined })] }), unpinned), 'list_issues'))
      .toBe('tool_drift');
    const silent = upstreamOk();
    silent[0] = Object.assign({}, silent[0], { annotations: {} });
    expect(verdictOf(assessEntryTools(linear({ tools: [pinned({ annotations: undefined })] }), silent), 'list_issues'))
      .toBe('ok');
  });
});

describe('the comparison is cached per row, and an outage is not cacheable', () => {
  const row = { connectionId: 'row-a' };

  // Deliberately does NOT pass a TTL: the shipped default is what most callers
  // get, and the arms that assert one fetch must witness it.
  const cache = (listUpstreamTools, over) =>
    createHostedMcpDriftCache(Object.assign({ listUpstreamTools }, over));

  test('the upstream list is taken once per row per TTL', async () => {
    let fetches = 0;
    let clock = 1000;
    const drift = cache(async () => {
      fetches += 1;
      return upstreamOk();
    }, { now: () => clock });

    const first = await drift.assess(row, linear());
    clock += 1;
    const second = await drift.assess(row, linear());
    expect(fetches).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.at).toBe(first.at);

    // Another member's row is another credential, so it is another fetch.
    await drift.assess({ connectionId: 'row-b' }, linear());
    expect(fetches).toBe(2);

    clock += 5 * 60 * 1000;
    const third = await drift.assess(row, linear());
    expect(fetches).toBe(3);
    expect(third.cached).toBe(false);
  });

  test('a vendor outage is provider_unavailable and is not cached', async () => {
    let fetches = 0;
    const drift = cache(async () => {
      fetches += 1;
      if (fetches === 1) throw new Error('ECONNRESET');
      return upstreamOk();
    });

    const failed = await drift.assess(row, linear());
    expect(failed.state).toBe('provider_unavailable');
    expect(failed.detail).toContain('ECONNRESET');
    expect(failed.tools).toBeUndefined();

    // The retry happens immediately: a failed fetch must not become a window
    // in which every tool reads as unchanged.
    const recovered = await drift.assess(row, linear());
    expect(recovered.state).toBe('assessed');
    expect(recovered.cached).toBe(false);
    expect(fetches).toBe(2);
  });

  test('forgetting a row drops only that row', async () => {
    const seen = [];
    const drift = cache(async (r) => {
      seen.push(r.connectionId);
      return upstreamOk();
    });
    await drift.assess(row, linear());
    await drift.assess({ connectionId: 'row-b' }, linear());
    drift.forget(row);
    await drift.assess(row, linear());
    await drift.assess({ connectionId: 'row-b' }, linear());
    expect(seen).toEqual(['row-a', 'row-b', 'row-a']);
  });
});

describe('the shipped catalogue cannot land half-wired', () => {
  test('v1 lists no vendor, and a lookup names the entry it was asked for', () => {
    expect(HOSTED_MCP_ENTRIES).toEqual([]);
    const catalogue = [linear(), linear({ id: 'notion', title: 'Notion' })];
    expect(findHostedMcpEntry(catalogue, 'notion').title).toBe('Notion');
    expect(findHostedMcpEntry(catalogue, 'linear').title).toBe('Linear');
    expect(findHostedMcpEntry(catalogue, 'atlassian')).toBeUndefined();
    expect(findHostedMcpEntry(HOSTED_MCP_ENTRIES, 'linear')).toBeUndefined();
  });

  test('a colliding entry id or tool name is refused', () => {
    // Control: a valid catalogue passes, so a throw below is about the collision.
    expect(() => assertHostedMcpEntries([linear(), linear({ id: 'notion', title: 'Notion' })])).not.toThrow();
    expect(() => assertHostedMcpEntries([linear(), linear()])).toThrow(/duplicate hosted-mcp entry id/);
    expect(() => assertHostedMcpEntries([linear({ id: 'lin.ear' })])).toThrow(/not a usable tool namespace/);
    expect(() => assertHostedMcpEntries([
      linear(),
      linear({ id: 'notion', title: 'Notion', tools: [pinned({ name: 'list_issues' })] }),
    ])).not.toThrow();
    expect(() => assertHostedMcpEntries([
      linear({ tools: [pinned({}), pinned({})] }),
    ])).toThrow(/duplicate hosted-mcp tool name: linear.list_issues/);
  });

  test('a namespaced name is the entry id and the pinned name', () => {
    const entry = linear();
    expect(hostedMcpToolName(entry, entry.tools[0])).toBe('linear.list_issues');
  });
});
