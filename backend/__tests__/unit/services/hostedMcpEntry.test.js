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
  hostedMcpRevokeTarget,
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
  revoke: {
    page: 'https://linear.app/settings/security',
    endpoint: 'https://mcp.linear.app/token',
  },
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
    const withdrawal = assessEntryTools(entry, withdrawn).find((a) => a.name === 'list_issues');
    expect(withdrawal.verdict).toBe('tool_drift');
    expect(withdrawal.detail).toContain('readOnlyHint withdrawn');

    // Acceptance control: the same annotations, unchanged. A vendor still
    // saying exactly what the pin recorded has moved nowhere.
    expect(verdictOf(assessEntryTools(entry, upstreamOk()), 'list_issues')).toBe('ok');

    // A live `destructiveHint: true` beside a recorded `readOnlyHint: true` is
    // the pair the entry load refuses, and drift does not admit later what the
    // entry refuses. The vendor's own `readOnlyHint` has to still be there, or
    // the withdrawal arm above answers first.
    const contradictory = upstreamOk();
    contradictory[0] = { ...contradictory[0], annotations: { readOnlyHint: true, destructiveHint: true } };
    const contradiction = assessEntryTools(entry, contradictory).find((a) => a.name === 'list_issues');
    expect(contradiction.verdict).toBe('tool_drift');
    expect(contradiction.detail).toContain('destructiveHint set upstream');

    // Acceptance control: a tool that gains readOnlyHint is claiming less than
    // it did, not more. Pinned `write` because #2014 refuses a read pin that
    // carries `destructiveHint: true`.
    const tightened = linear({
      tools: [pinned({
        class: 'write',
        annotations: { destructiveHint: true },
        inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
      })],
    });
    expect(verdictOf(assessEntryTools(tightened, upstreamOk()), 'list_issues')).toBe('ok');
    // The fixture is entry-legal: #2014 refuses a read pin carrying
    // `destructiveHint: true`, so this one is pinned `write`.
    expect(() => assertHostedMcpEntries([tightened])).not.toThrow();

    // A pin that recorded nothing does not drift when the vendor spells a spec
    // default: there is no claim to withdraw. Both are `write` pins, because
    // #2014 refuses a read pin that records no `readOnlyHint`.
    const recordedNothing = () => linear({ tools: [pinned({ class: 'write', annotations: undefined })] });
    const unpinned = upstreamOk();
    unpinned[0] = { ...unpinned[0], annotations: { destructiveHint: true } };
    expect(verdictOf(assessEntryTools(recordedNothing(), unpinned), 'list_issues')).toBe('ok');
    const silent = upstreamOk();
    silent[0] = { ...silent[0], annotations: {} };
    expect(verdictOf(assessEntryTools(recordedNothing(), silent), 'list_issues')).toBe('ok');
    // And the shape is entry-legal, which a `read` pin recording no
    // `readOnlyHint` is not (#2014).
    expect(() => assertHostedMcpEntries([recordedNothing()])).not.toThrow();
  });

  test('a claim the pin recorded is withdrawn by silence, and the refusal names it', () => {
    // The spec defaults an absent `destructiveHint` to `true`, so a vendor that
    // goes quiet has withdrawn a recorded `destructiveHint: false` — drift even
    // though the tool grew no new capability.
    const nonDestructive = linear({
      tools: [pinned({ annotations: { readOnlyHint: true, destructiveHint: false } })],
    });
    const quietUpstream = upstreamOk();
    quietUpstream[0] = { ...quietUpstream[0], annotations: { readOnlyHint: true } };
    const quiet = assessEntryTools(nonDestructive, quietUpstream).find((a) => a.name === 'list_issues');
    expect(quiet.verdict).toBe('tool_drift');
    expect(quiet.detail).toContain('destructiveHint: false');

    // The same claim on a `write` pin, where #2014 constrains nothing: the
    // withdrawal is drift there too.
    const writeQuietUpstream = upstreamOk();
    writeQuietUpstream[0] = { ...writeQuietUpstream[0], annotations: {} };
    const writeNonDestructive = linear({
      tools: [pinned({ class: 'write', annotations: { destructiveHint: false } })],
    });
    expect(verdictOf(assessEntryTools(writeNonDestructive, writeQuietUpstream), 'list_issues')).toBe('tool_drift');

    // Both claims recorded, and the vendor now says both: two arms apply, and the
    // refusal names the claim the pin lost rather than the contradiction.
    const contradictory = upstreamOk();
    contradictory[0] = { ...contradictory[0], annotations: { readOnlyHint: true, destructiveHint: true } };
    const both = assessEntryTools(nonDestructive, contradictory).find((a) => a.name === 'list_issues');
    expect(both.verdict).toBe('tool_drift');
    expect(both.detail).toContain('destructiveHint: false');
    expect(both.detail).not.toContain('set upstream');
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
  test('ships Linear and nothing else, and a lookup names the entry it was asked for', () => {
    // Step 7: the catalogue's first entry. A second vendor landing here changes
    // this line, which is the point — it is the one place that says what an
    // instance offers before any member has connected anything.
    expect(HOSTED_MCP_ENTRIES.map((entry) => entry.id)).toEqual(['linear']);
    const catalogue = [linear(), linear({ id: 'notion', title: 'Notion' })];
    expect(findHostedMcpEntry(catalogue, 'notion').title).toBe('Notion');
    expect(findHostedMcpEntry(catalogue, 'linear').title).toBe('Linear');
    expect(findHostedMcpEntry(catalogue, 'atlassian')).toBeUndefined();
    expect(findHostedMcpEntry(HOSTED_MCP_ENTRIES, 'notion')).toBeUndefined();
    expect(findHostedMcpEntry(HOSTED_MCP_ENTRIES, 'linear').title).toBe('Linear');
  });

  test('the shipped Linear entry is read-only, fully annotated and names a revoke page', () => {
    const [entry] = HOSTED_MCP_ENTRIES;
    // 38 tools were measured at scope `read`; two caller-chosen fetch paths are
    // excluded by the v1 target-fetch rule, leaving the reviewed 36-tool pin.
    expect(entry.tools).toHaveLength(36);
    expect(entry.tools.map((tool) => tool.name)).not.toContain('get_attachment');
    expect(entry.tools.map((tool) => tool.name)).not.toContain('extract_images');
    expect(new Set(entry.tools.map((tool) => tool.class))).toEqual(new Set(['read']));
    expect(entry.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(entry.tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
    // Every name an agent sees is the upstream name, which the entry load
    // requires and the broker calls with.
    expect(entry.tools.every((tool) => tool.name === tool.upstreamName)).toBe(true);
    expect(new Set(entry.tools.map((tool) => `${entry.id}.${tool.name}`)).size).toBe(36);
    expect(hostedMcpRevokeTarget(entry)).toEqual({ page: 'https://linear.app/settings/security' });
    // The three identity fields the intake reads: `resource` is the RFC 8707
    // value every authorization and token request carries, `issuer` is what the
    // callback checks a returned `iss` against (RFC 9207), and `client: 'cimd'`
    // is what keeps a client secret out of the instance entirely.
    expect(entry.resource).toBe('https://mcp.linear.app/mcp');
    expect(entry.issuer).toBe('https://mcp.linear.app');
    expect(entry.client).toBe('cimd');
    expect([...entry.scopes].sort()).toEqual(['openid', 'read']);
  });

  test('the Linear pin is the measured list minus caller-chosen fetch paths', () => {
    // The capture `connector-ops` took on 2026-10-01 is committed beside this
    // suite, so the pin's schemas are compared with the measurement rather than
    // with themselves. Drift is checked against the LIVE list at call time; this
    // is the other end, catching a hand-edit of the entry that would otherwise
    // only surface as every tool refusing `tool_drift` in production.
    const capture = require('../../fixtures/hostedMcp/linear-tools-list-2026-10-01.json');
    const [entry] = HOSTED_MCP_ENTRIES;
    expect(capture.server).toBe(entry.resource);
    expect(capture.requestedScope.split(' ').sort()).toEqual([...entry.scopes].sort());
    const measured = new Map(capture.tools.map((tool) => [tool.name, tool]));
    const excludedForCallerChosenFetch = new Set(['get_attachment', 'extract_images']);
    expect(entry.tools.map((tool) => tool.name)).toEqual(
      capture.tools.filter((tool) => !excludedForCallerChosenFetch.has(tool.name)).map((tool) => tool.name),
    );
    expect(capture.tools.filter((tool) => !entry.tools.some((pinned) => pinned.name === tool.name))
      .map((tool) => tool.name).sort()).toEqual([...excludedForCallerChosenFetch].sort());
    for (const tool of entry.tools) {
      const found = measured.get(tool.name);
      expect(found).toBeDefined();
      expect(canonicalJson(tool.inputSchema)).toBe(canonicalJson(found.inputSchema));
      expect(tool.annotations?.readOnlyHint).toBe(found.annotations.readOnlyHint);
      expect(tool.annotations?.destructiveHint).toBe(found.annotations.destructiveHint);
    }
    // One annotation set across the whole list, which is what the header claims
    // and what makes a single `READ_ANNOTATIONS` honest.
    expect(new Set(capture.tools.map((tool) => JSON.stringify(tool.annotations))).size).toBe(1);
    expect(capture.tools).toHaveLength(38);
    expect(entry.tools.find((tool) => tool.name === 'get_diff').description).toContain('not fetch targets');
    expect(entry.tools.find((tool) => tool.name === 'get_diff_threads').description).toContain('not fetch targets');
  });

  test('a colliding entry id or tool name is refused', () => {
    // Control: a valid catalogue passes, so a throw below is about the collision.
    expect(() => assertHostedMcpEntries([linear(), linear({ id: 'notion', title: 'Notion' })])).not.toThrow();
    expect(() => assertHostedMcpEntries([linear(), linear()])).toThrow(/duplicate hosted-mcp entry id/);
    expect(() => assertHostedMcpEntries([linear({ id: 'lin.ear' })])).toThrow(/not a usable tool namespace/);
    // Control: the shipped shape is accepted, so the three refusals above are
    // about the value and not about the field being read at all.
    expect(() => assertHostedMcpEntries([linear()])).not.toThrow();
    expect(() => assertHostedMcpEntries([
      linear(),
      linear({ id: 'notion', title: 'Notion', tools: [pinned({ name: 'list_issues' })] }),
    ])).not.toThrow();
    expect(() => assertHostedMcpEntries([
      linear({ tools: [pinned({}), pinned({})] }),
    ])).toThrow(/duplicate hosted-mcp tool name: linear.list_issues/);
  });

  test('a revoke target is a page plus an optional https endpoint, and every URL it names is checked', () => {
    // §3: every entry names a `page`, and an `endpoint` only when the AS's
    // metadata advertises one. Both are https URLs, so the URL cannot say which
    // one decides the vendor call — presence of `endpoint` does, and that is
    // why a page is required even on an entry that has one: a removal that
    // cannot revoke at the vendor hands the person that page.
    const bothURLs = {
      endpoint: 'https://mcp.linear.app/token',
      page: 'https://linear.app/settings/security',
    };
    const noRevoke = linear();
    delete noRevoke.revoke;
    expect(() => assertHostedMcpEntries([noRevoke]))
      .toThrow(/names no page/);
    // A page-less entry is refused even when it has an endpoint: the endpoint
    // revoke can fail, and then the page is the only thing left to hand over.
    expect(() => assertHostedMcpEntries([linear({ revoke: { endpoint: bothURLs.endpoint } })]))
      .toThrow(/names no page/);
    // A key the entry format does not have, including a `kind`/`url` pair:
    // the key IS the kind, so naming it in a value is naming nothing.
    expect(() => assertHostedMcpEntries([linear({ revoke: { page: bothURLs.page, kind: 'endpoint' } })]))
      .toThrow(/names a key that is neither `page` nor `endpoint` \(kind\)/);
    expect(() => assertHostedMcpEntries([linear({ revoke: '/token' })]))
      .toThrow(/names no page/);
    // Every URL present is checked, not just the first. This arm could not fire
    // while a two-key `revoke` was refused outright, and it is the arm that
    // keeps a person from being handed a page nothing can open.
    expect(() => assertHostedMcpEntries([linear({ revoke: { page: 'linear.app/settings', endpoint: bothURLs.endpoint } })]))
      .toThrow(/is not an absolute https URL \(page\)/);
    expect(() => assertHostedMcpEntries([linear({ revoke: { page: bothURLs.page, endpoint: 'http://mcp.linear.app/token' } })]))
      .toThrow(/is not an absolute https URL \(endpoint\)/);
    expect(() => assertHostedMcpEntries([linear({ revoke: { page: bothURLs.page, endpoint: '' } })]))
      .toThrow(/is not an absolute https URL \(endpoint\)/);
    expect(() => assertHostedMcpEntries([linear({ revoke: { page: '' } })]))
      .toThrow(/is not an absolute https URL \(page\)/);
    // Acceptance controls: BOTH shapes load — a page alone, and a page with an
    // endpoint — so the refusals above are about the shape and not about
    // `revoke` being refused in general, or about two keys being refused.
    expect(() => assertHostedMcpEntries([linear({ revoke: { page: bothURLs.page } })]))
      .not.toThrow();
    expect(() => assertHostedMcpEntries([linear({ revoke: bothURLs })]))
      .not.toThrow();
    // The target is read from the same place, and it keeps both URLs: which one
    // the vendor call uses is `endpoint`'s presence, and which one a person is
    // handed is always the page.
    expect(hostedMcpRevokeTarget(linear({ revoke: bothURLs })))
      .toEqual({ page: bothURLs.page, endpoint: bothURLs.endpoint });
    expect(hostedMcpRevokeTarget(linear({ revoke: { page: bothURLs.page } })))
      .toEqual({ page: bothURLs.page });
  });

  test('a namespaced name is the entry id and the pinned name', () => {
    const entry = linear();
    expect(hostedMcpToolName(entry, entry.tools[0])).toBe('linear.list_issues');
  });
});

// The three preconditions a vendor entry has to satisfy before the first one is
// pinned (TASK-172, the row's notes from Vera). Each guard is measured by its
// own refusal beside a control, and the refusals are asserted separately
// because they are separate messages: one could keep working while another
// stops, and an arm that accepts any of them would not say which.
const refusal = (entries) => {
  try {
    assertHostedMcpEntries(entries);
  } catch (error) {
    return error.message;
  }
  throw new Error('the catalogue was accepted; this arm expected a refusal');
};

describe('a pin cannot contradict the class or the namespace it is filed under', () => {
  test('a tool name the namespace cannot carry is refused', () => {
    // Control: a kebab name and the underscore spelling the eight shipped
    // GitHub tool names already use both pass, so the refusals below are about
    // the characters named rather than about the guard refusing everything.
    expect(() => assertHostedMcpEntries([linear({ tools: [pinned({ name: 'list-issues' })] })])).not.toThrow();
    expect(() => assertHostedMcpEntries([linear()])).not.toThrow();

    // The separator itself, and two characters no seat-facing tool name carries.
    expect(refusal([linear({ tools: [pinned({ name: 'list.issues' })] })]))
      .toContain('not a usable namespace segment: linear.list.issues');
    expect(refusal([linear({ tools: [pinned({ name: 'list issues' })] })]))
      .toContain('not a usable namespace segment: linear.list issues');
    expect(refusal([linear({ tools: [pinned({ name: 'List_issues' })] })]))
      .toContain('not a usable namespace segment: linear.List_issues');
  });

  test('a read pin whose own annotations say destructive is refused', () => {
    // Control: the same annotations on a tool pinned `write` are honest — the
    // class parks the call, and the drift comparison starts from a write claim.
    expect(() => assertHostedMcpEntries([
      linear({ tools: [pinned({ name: 'delete_issue', class: 'write', annotations: { destructiveHint: true } })] }),
    ])).not.toThrow();
    // A tightened claim is not a contradiction either: `destructiveHint: false`
    // on a read tool agrees with the class.
    expect(() => assertHostedMcpEntries([
      linear({ tools: [pinned({ annotations: { readOnlyHint: true, destructiveHint: false } })] }),
    ])).not.toThrow();

    expect(refusal([linear({ tools: [pinned({ annotations: { destructiveHint: true } })] })]))
      .toContain('hosted-mcp read tool is pinned against its own destructiveHint: linear.list_issues');
  });

  test('a read pin whose own annotations deny readOnly is refused', () => {
    // Control: `readOnlyHint: false` on a `write` pin describes a write tool.
    expect(() => assertHostedMcpEntries([
      linear({ tools: [pinned({ name: 'create_issue', class: 'write', annotations: { readOnlyHint: false } })] }),
    ])).not.toThrow();

    expect(refusal([linear({ tools: [pinned({ annotations: { readOnlyHint: false } })] })]))
      .toContain('hosted-mcp read tool is pinned against its own readOnlyHint: linear.list_issues');
  });

  test('the annotation refusals are told apart by name', () => {
    // Asserting the code is not asserting the message, and here there is no
    // code at all: a module-load throw is read by whoever ran the build, so the
    // text is the only thing that says what was found. `readOnlyHint: false` is
    // refused by the guard that names it even though the claim guard below also
    // reaches it, which is why that guard is not simply the only one kept.
    const destructive = refusal([linear({ tools: [pinned({ annotations: { destructiveHint: true } })] })]);
    const notReadOnly = refusal([linear({ tools: [pinned({ annotations: { readOnlyHint: false } })] })]);
    expect(destructive).not.toBe(notReadOnly);
    expect(destructive).toContain('destructiveHint');
    expect(notReadOnly).toContain('pinned against its own readOnlyHint');
  });
});

// Vera's third arm: the two guards above refuse a read pin that CONTRADICTS an
// annotation. This one refuses a read pin that never made the claim, which is
// the state an author writes by default.
describe('a read pin has to claim the class, not just avoid denying it', () => {
  test('a read pin carrying no readOnlyHint is refused', () => {
    // Control: a `write` pin needs no claim — the class parks the call and no
    // drift direction is keyed on it — and a read pin that claims read-only is
    // the shipped fixture's own shape.
    expect(() => assertHostedMcpEntries([
      linear({ tools: [pinned({ name: 'create_issue', class: 'write', annotations: undefined })] }),
    ])).not.toThrow();
    expect(() => assertHostedMcpEntries([linear()])).not.toThrow();

    expect(refusal([linear({ tools: [pinned({ annotations: undefined })] })]))
      .toContain('hosted-mcp read tool does not claim readOnlyHint: linear.list_issues');
    expect(refusal([linear({ tools: [pinned({ annotations: { destructiveHint: false } })] })]))
      .toContain('hosted-mcp read tool does not claim readOnlyHint: linear.list_issues');
  });

  test('the claim is what keeps the withdrawal direction live', () => {
    // Measured through `assessEntryTools`, which is what the guard protects: a
    // read pin with no claim is answered `ok` while the vendor says
    // `readOnlyHint: false`, so a read grant would stand against an explicit
    // upstream denial. The pin below is not a catalogue state any more — the
    // load guard refuses it — and that is the point of keeping the hole on the
    // record: the drift comparison cannot see it on its own.
    const silentPin = linear({ tools: [pinned({ annotations: undefined })] });
    const denial = [{ ...upstreamOk()[0], annotations: { readOnlyHint: false } }];
    expect(assessEntryTools(silentPin, denial)[0]).toMatchObject({ verdict: 'ok' });

    // The same vendor answer against the claim the guard now requires.
    const claimedPin = linear();
    expect(assessEntryTools(claimedPin, denial)[0]).toMatchObject({
      verdict: 'tool_drift',
      detail: 'readOnlyHint withdrawn upstream',
    });
  });
});
