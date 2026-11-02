/**
 * The guard-name canary's pure parts (scripts/guard-name-canary.js).
 *
 * On 2026-11-01 a hosted agent whose name began with "Dan" was blocked on every
 * turn: its system prompt opened "You are Dan…", which contains the injection
 * guard's always-block keyword "you are dan". Nothing before release ran a real
 * agent turn through the guard, so no test name ever came near one. The
 * canary installs agents whose names complete a persona keyword and checks
 * each gets a real turn. These tests pin the three decisions it makes without
 * a cluster: which names to try, which of those a guard may block for a
 * reason that is not ours, and what a check's outcome means for the release.
 */
const {
  parseKeywordPayload,
  findKeyword,
  deriveCanaryNames,
  mentionText,
  classifyCheck,
  exitCodeFor,
  planChecks,
  combineAttempts,
  BLOCKED_EXIT,
} = require('../../../../scripts/guard-name-canary');

// The guard's lists as measured on the litellm image (v1.106.2), trimmed.
const KEYWORDS = [
  'DAN mode', 'Do Anything Now', 'jailbreak', 'jailbroken', 'bypass safety',
  'ignore previous instructions', 'you are now', 'new persona', 'act as DAN',
  'you are DAN', 'your new role is', 'dump database',
];

describe('parseKeywordPayload', () => {
  it('flattens every category into one lowercased, de-duplicated list', () => {
    const parsed = parseKeywordPayload(JSON.stringify({
      guard: 'injection-guard',
      categories: { a: ['You are DAN', 'jailbreak'], b: ['you are dan', 'dump database'] },
    }));
    expect(parsed.ok).toBe(true);
    expect(parsed.keywords).toEqual(['you are dan', 'jailbreak', 'dump database']);
    expect(parsed.categories).toEqual(['a', 'b']);
  });

  it('reports an unreadable list rather than an empty one', () => {
    expect(parseKeywordPayload('').ok).toBe(false);
    expect(parseKeywordPayload('not json').ok).toBe(false);
    expect(parseKeywordPayload(JSON.stringify({ categories: {} })).ok).toBe(false);
    expect(parseKeywordPayload(JSON.stringify({ error: 'no guard' })).ok).toBe(false);
  });
});

describe('findKeyword', () => {
  it('matches case-insensitively anywhere in the text', () => {
    expect(findKeyword('Hello. You are Danica, a helper.', ['you are dan'])).toBe('you are dan');
    expect(findKeyword('Your name on Commonly is Danica.', ['you are dan'])).toBeNull();
  });
});

describe('deriveCanaryNames', () => {
  it('names a canary for each persona keyword, so "you are DAN" gives Dan and "you are now" gives Now', () => {
    const { names } = deriveCanaryNames(KEYWORDS.map((k) => k.toLowerCase()));
    expect(names.map((n) => n.displayName)).toEqual(['Dan Canary', 'Now Canary']);
    expect(names[0]).toMatchObject({ instanceId: 'dan-canary', keywords: ['act as dan', 'you are dan'] });
    expect(names[1]).toMatchObject({ instanceId: 'now-canary', keywords: ['you are now'] });
  });

  it('keeps Dan when the list is unreadable, because Dan is the name that broke', () => {
    const { names } = deriveCanaryNames([]);
    expect(names.map((n) => n.displayName)).toEqual(['Dan Canary']);
    expect(names[0].keywords).toEqual([]);
  });

  it('covers a persona keyword the guard adds later', () => {
    const { names } = deriveCanaryNames([...KEYWORDS, 'pretend to be Mallory', "you're Sydney"].map((k) => k.toLowerCase()));
    expect(names.map((n) => n.displayName)).toEqual(['Dan Canary', 'Now Canary', 'Mallory Canary', 'Sydney Canary']);
  });

  it('skips a name that contains a whole keyword: a person typing it would be blocked, and that block is the guard working', () => {
    const { names, skipped } = deriveCanaryNames(['you are dan', 'act as jailbreak', 'jailbreak']);
    expect(names.map((n) => n.displayName)).toEqual(['Dan Canary']);
    expect(skipped).toEqual([{ stem: 'jailbreak', keyword: 'act as jailbreak', reason: 'name_contains_keyword' }]);
  });

  it('tries at most eight names, so the keyword list cannot set how many turns a release pays for', () => {
    const many = Array.from({ length: 12 }, (_, i) => `you are agent${String.fromCharCode(97 + i)}`);
    const { names, skipped } = deriveCanaryNames(many);
    expect(names).toHaveLength(8);
    expect(names[0].displayName).toBe('Dan Canary');
    expect(skipped.filter((x) => x.reason === 'over_cap')).toHaveLength(5);
  });

  it('skips a stem whose name would run past 60 characters', () => {
    const { names, skipped } = deriveCanaryNames([`you are ${'x'.repeat(60)}`]);
    expect(names.map((n) => n.displayName)).toEqual(['Dan Canary']);
    expect(skipped).toEqual([expect.objectContaining({ reason: 'name_too_long' })]);
  });

  it('every derived name completes its keyword after "You are" and "act as"', () => {
    const { names } = deriveCanaryNames(KEYWORDS.map((k) => k.toLowerCase()));
    for (const n of names) {
      for (const k of n.keywords) {
        const completed = [`You are ${n.displayName}`, `act as ${n.displayName}`]
          .some((text) => findKeyword(text, [k]) === k);
        expect(completed).toBe(true);
      }
    }
  });
});

describe('mentionText', () => {
  it('addresses the agent by its canonical handle with a plain question, and carries no keyword', () => {
    const text = mentionText('guard-canary-dan-canary');
    expect(text.startsWith('@guard-canary-dan-canary ')).toBe(true);
    expect(findKeyword(text, KEYWORDS.map((k) => k.toLowerCase()))).toBeNull();
    // The first live run asked for a code echoed verbatim: every model declined
    // it as a relay request, so a working turn read as no reply.
    expect(text).not.toMatch(/exactly|verbatim|code/i);
  });
});

describe('classifyCheck', () => {
  const run = (over) => ({ status: 'succeeded', errorKind: null, trigger: 'mention', ...over });

  it('passes on a succeeded mention turn and a reply after the mention', () => {
    expect(classifyCheck({ runs: [run({ trigger: 'first_contact' }), run()], replied: true }))
      .toEqual({ verdict: 'pass' });
  });

  it('is blocked when any run since install was stopped by the guard, even if a later one replied', () => {
    expect(classifyCheck({ runs: [run({ status: 'failed', errorKind: 'guardrail_blocked', trigger: 'first_contact' }), run()], replied: true }))
      .toEqual({ verdict: 'blocked', reason: 'guardrail_blocked on first_contact' });
  });

  it('is inconclusive, never a pass, when the mention turn did not both run and reply', () => {
    expect(classifyCheck({ runs: [], replied: false })).toEqual({ verdict: 'inconclusive', reason: 'no_run' });
    expect(classifyCheck({ runs: [run({ status: 'failed', errorKind: 'model_error' })], replied: false }))
      .toEqual({ verdict: 'inconclusive', reason: 'run failed: model_error' });
    expect(classifyCheck({ runs: [run()], replied: false })).toEqual({ verdict: 'inconclusive', reason: 'no_reply' });
    // The greeting can post after the mention; it is not the mention's turn.
    expect(classifyCheck({ runs: [run({ trigger: 'first_contact' })], replied: true }))
      .toEqual({ verdict: 'inconclusive', reason: 'no_mention_run' });
  });

  it('is inconclusive when the install itself failed', () => {
    expect(classifyCheck({ installError: 'HTTP 403 hosted_cap_reached', runs: [], replied: false }))
      .toEqual({ verdict: 'inconclusive', reason: 'install: HTTP 403 hosted_cap_reached' });
  });
});

describe('planChecks', () => {
  it('plans a hosted and a native check per name under the canonical handles', () => {
    const { names } = deriveCanaryNames(['you are dan']);
    expect(planChecks(names, ['you are dan'])).toEqual([
      expect.objectContaining({ runtime: 'hosted', agentName: 'guard-canary', handle: 'guard-canary-dan-canary', skip: null }),
      expect.objectContaining({ runtime: 'native', agentName: 'task-clerk', handle: 'task-clerk-dan-canary', skip: null }),
    ]);
  });

  it('never posts a question the guard would stop on its own text', () => {
    const { names } = deriveCanaryNames(['you are dan']);
    // A future keyword that the question itself contains.
    const plan = planChecks(names, ['you are dan', 'quick check from the release canary']);
    expect(plan.every((c) => c.skip === 'question_contains_keyword')).toBe(true);
  });
});

describe('combineAttempts', () => {
  const pass = { verdict: 'pass' };
  const blocked = { verdict: 'blocked', reason: 'guardrail_blocked on mention' };
  const quiet = { verdict: 'inconclusive', reason: 'no_reply' };

  it('is blocked only when both attempts were blocked: a keyword match repeats, an upstream error does not', () => {
    expect(combineAttempts(blocked, blocked).verdict).toBe('blocked');
    expect(combineAttempts(blocked, pass)).toMatchObject({ verdict: 'inconclusive', reason: 'blocked once, then pass' });
    expect(combineAttempts(quiet, blocked)).toMatchObject({ verdict: 'inconclusive', reason: 'no_reply, then blocked once' });
  });

  it('takes the second attempt otherwise', () => {
    expect(combineAttempts(quiet, pass)).toEqual(pass);
    expect(combineAttempts(quiet, quiet)).toEqual(quiet);
  });
});

describe('exitCodeFor', () => {
  it(`${BLOCKED_EXIT} when any check was blocked; 2 when any was inconclusive, the list unread or names were capped; else 0`, () => {
    // Blocked has its own code: kubectl and an uncaught node error both exit 1,
    // and neither may read as a guard block that rolls a release back.
    expect(BLOCKED_EXIT).not.toBe(1);
    expect(BLOCKED_EXIT).not.toBe(2);
    expect(exitCodeFor([{ verdict: 'pass' }], true, true)).toBe(2);
    expect(exitCodeFor([{ verdict: 'blocked' }], true, true)).toBe(BLOCKED_EXIT);
    expect(exitCodeFor([{ verdict: 'pass' }, { verdict: 'pass' }], true)).toBe(0);
    expect(exitCodeFor([{ verdict: 'pass' }, { verdict: 'inconclusive' }], true)).toBe(2);
    expect(exitCodeFor([{ verdict: 'inconclusive' }, { verdict: 'blocked' }], true)).toBe(BLOCKED_EXIT);
    expect(exitCodeFor([{ verdict: 'pass' }], false)).toBe(2);
    expect(exitCodeFor([{ verdict: 'blocked' }], false)).toBe(BLOCKED_EXIT);
    expect(exitCodeFor([], true)).toBe(2);
  });
});
