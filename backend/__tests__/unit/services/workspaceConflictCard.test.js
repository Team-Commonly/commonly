/**
 * A refused workspace merge becomes ONE decision request, bound to the heads it
 * was built from. The request must pass the same checks the decision route
 * applies, or the agent's card is refused at the door.
 *
 * Fixtures follow the Conflict shape LayerFS 582bc786f9 returns: `detail` has
 * `sources` ([ours, theirs] as { ref, node }), `mergeBase`, and `conflicts[]`
 * with per-hunk line numbers and both sides as line arrays. The two-path case
 * is the payload a real LayerFS merge refused with (README content plus the
 * binary /.git/index), captured 10-29.
 */
const { mergeConflictToDecisionRequest } = require('../../../services/workspaceConflictCard');
const { normalizeDecisionClass, normalizeOptions } = require('../../../services/decisionRequestService');

const OURS_NODE = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const THEIRS_NODE = 'f0e9d8c7b6a5f4e3d2c1f0e9d8c7b6a5f4e3d2c1';
const BASE_NODE = '0123456789abcdef0123456789abcdef01234567';

const readme = {
  path: '/README.md',
  kind: 'content',
  blocks: 1,
  hunksOmitted: false,
  hunks: [{
    line: 111,
    ours: ['Install with npm i -g commonly.', ''],
    theirs: ['Install with pnpm add -g commonly.', ''],
  }],
};
const gitIndex = { path: '/.git/index', kind: 'binary', hunks: [] };

const refusal = (conflicts, { ours = 'main', theirs = 'agent-b', extra = {} } = {}) => ({
  sources: [{ ref: ours, node: OURS_NODE }, { ref: theirs, node: THEIRS_NODE }],
  mergeBase: BASE_NODE,
  conflicts,
  ...extra,
});
const one = (conflict, names) => mergeConflictToDecisionRequest(refusal([conflict], names));
const accepted = (req) => {
  expect(() => normalizeOptions(req.options)).not.toThrow();
  expect(normalizeDecisionClass(req.decisionClass)).toBe('implementation');
  expect(req.title.length).toBeLessThanOrEqual(160);
  expect(req.question.length).toBeLessThanOrEqual(1000);
  expect(req.context.length).toBeLessThanOrEqual(2000);
  req.options.forEach((o) => {
    expect(o.label.length).toBeLessThanOrEqual(80);
    if ('description' in o) expect(o.description.length).toBeLessThanOrEqual(280);
  });
};

describe('the captured two-path merge: README content plus /.git/index', () => {
  const req = mergeConflictToDecisionRequest(refusal([readme, gitIndex]));

  test('gives one request, about the README, with /.git/index folded into one line', () => {
    expect(req.title).toBe('Merge conflict in /README.md:111');
    expect(req.question).toBe('agent-b and main both changed /README.md:111. Which version should land?');
    expect(req.context).toContain('File /README.md (content, 1 conflict block)');
    expect(req.context).toContain("Git's own files also differ: /.git/index. They hold no source text, so they aren't listed as choices.");
    expect(req.context).not.toContain('File /.git/index');
    expect(req.context).toContain('Conflicting files: 1');
    accepted(req);
  });

  test("offers ours and theirs by branch name, each with its own side's lines", () => {
    expect(req.options.map((o) => o.label)).toEqual(['Keep ours (main)', 'Keep theirs (agent-b)', 'Write the merged text']);
    expect(req.options[0].description).toBe('Install with npm i -g commonly.\n');
    expect(req.options[1].description).toBe('Install with pnpm add -g commonly.\n');
    expect(req.context).toContain('main: Install with npm i -g commonly.');
    expect(req.context).toContain('agent-b: Install with pnpm add -g commonly.');
  });

  test('carries both heads and the merge base, for a re-run that refuses if a head moved', () => {
    expect(req.merge).toEqual({
      ours: { ref: 'main', node: OURS_NODE },
      theirs: { ref: 'agent-b', node: THEIRS_NODE },
      mergeBase: BASE_NODE,
    });
    expect(req.context).toContain(`Heads: ours ${OURS_NODE.slice(0, 12)}, theirs ${THEIRS_NODE.slice(0, 12)}, merge base ${BASE_NODE.slice(0, 12)}.`);
  });

  test('says "base" only for the merge base, never for a side', () => {
    req.options.forEach((o) => expect(o.label).not.toMatch(/base/i));
    expect(req.question).not.toMatch(/base/i);
  });
});

describe('one request per merge', () => {
  const second = {
    path: '/src/app.js', kind: 'content', blocks: 2, hunks: [{ line: 4, ours: ['a'], theirs: ['b'] }, { line: 9, ours: ['c'], theirs: ['d'] }],
  };

  test('N conflicting paths give one request that lists them, not N requests', () => {
    const req = mergeConflictToDecisionRequest(refusal([readme, second]));
    expect(req.title).toBe('Merge conflict in /README.md and 1 more file');
    expect(req.question).toBe('agent-b and main both changed the same 2 files: /README.md, /src/app.js. Which version should land?');
    expect(req.context).toContain('Conflicting files: 2');
    expect(req.context).toContain('File /README.md (content, 1 conflict block)');
    expect(req.context).toContain('File /src/app.js (content, 2 conflict blocks)');
    expect(req.context).toContain('line 9\nmain: c\nagent-b: d');
    expect(req.options[0].description).toBe("Take main's version of all 2 files.");
    expect(req.options[1].description).toBe("Take agent-b's version of all 2 files.");
    accepted(req);
  });

  test('a side that deleted some of the files says so in its option', () => {
    const deleted = { path: '/old.txt', kind: 'modify/delete', hunks: [{ line: 1, ours: ['kept'], theirs: [] }] };
    const req = mergeConflictToDecisionRequest(refusal([readme, deleted]));
    expect(req.options[0].description).toBe("Take main's version of all 2 files.");
    expect(req.options[1].description).toBe("Take agent-b's version of all 2 files. It deleted 1 of them.");
  });

  test('many large files stay inside the context limit, and the cut is named', () => {
    const block = 'y'.repeat(400);
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `/f${i}.md`, kind: 'content', blocks: 1, hunks: [{ line: 1, ours: [block], theirs: [block] }],
    }));
    const req = mergeConflictToDecisionRequest(refusal([...files, gitIndex]));
    expect(req.context.length).toBeLessThanOrEqual(2000);
    expect(req.context).toContain("Git's own files also differ: /.git/index.");
    expect(req.context).toMatch(/\d+ more files not shown\]$/);
    accepted(req);
  });

  test('fifty paths still end in the question, with the path list clipped instead', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `/packages/some-long-package-name-${i}/src/index.ts`, kind: 'content', hunks: [{ line: 1, ours: ['a'], theirs: ['b'] }],
    }));
    const req = mergeConflictToDecisionRequest(refusal(files));
    expect(req.question.length).toBeLessThanOrEqual(1000);
    expect(req.question).toMatch(/both changed the same 50 files: .*…\. Which version should land\?$/);
    accepted(req);
  });

  test('a refusal that lists no paths still asks a question that makes sense', () => {
    const req = mergeConflictToDecisionRequest(refusal([], { extra: { conflictsTruncated: true } }));
    expect(req.question).toBe('agent-b and main conflict, but the merge listed no paths. Which version should land?');
    expect(req.title).toBe('Merge conflict: agent-b into main');
    accepted(req);
  });

  test('a truncated refusal says the choice covers the paths it left out', () => {
    const req = mergeConflictToDecisionRequest(refusal([readme], { extra: { conflictsTruncated: true } }));
    expect(req.question).toBe('The merge listed only some conflicting paths, and this choice covers all of them. '
      + 'agent-b and main both changed /README.md:111. Which version should land?');
    const untruncated = mergeConflictToDecisionRequest(refusal([readme]));
    expect(untruncated.question).toBe('agent-b and main both changed /README.md:111. Which version should land?');
    accepted(req);
  });

  test('a truncated multi-file refusal keeps its question and speaks of every conflicting file', () => {
    const files = Array.from({ length: 50 }, (_, i) => ({
      path: `/packages/some-long-package-name-${i}/src/index.ts`, kind: 'content', hunks: [{ line: 1, ours: ['a'], theirs: ['b'] }],
    }));
    const req = mergeConflictToDecisionRequest(refusal(files, { extra: { conflictsTruncated: true } }));
    expect(req.question).toMatch(/^The merge listed only some conflicting paths/);
    expect(req.question).toMatch(/Which version should land\?$/);
    expect(req.options[0].description).toBe("Take main's version of every conflicting file.");
    accepted(req);
  });

  test('a long deleting branch name never clips the delete warning off', () => {
    const deleted = { path: '/old.txt', kind: 'modify/delete', hunks: [{ line: 1, ours: ['kept'], theirs: [] }] };
    const req = mergeConflictToDecisionRequest(refusal([readme, deleted], { theirs: 'z'.repeat(400) }));
    expect(req.options[1].description).toMatch(/'s version of all 2 files\. It deleted 1 of them\.$/);
    accepted(req);
  });

  test('with several files, writing the merged text asks for each path\'s text', () => {
    const second = { ...readme, path: '/b.md' };
    const req = mergeConflictToDecisionRequest(refusal([readme, second]));
    expect(req.options[2].description).toBe("Reply with each file's merged text under its path, and the merge runs again.");
    expect(one(readme).options[2].description).toBe('Reply with the text to land, and the merge runs again.');
  });

  test('a merge that listed only some paths says so', () => {
    const req = mergeConflictToDecisionRequest(refusal([readme], { extra: { conflictsTruncated: true } }));
    expect(req.context).toContain('Conflicting files: 1 listed; the merge listed only some.');
  });

  test('/.git/index alone is still a refused merge, so it is the card', () => {
    const req = mergeConflictToDecisionRequest(refusal([gitIndex]));
    expect(req.title).toBe('Merge conflict in /.git/index');
    expect(req.context).toContain('File /.git/index (binary)');
    expect(req.context).toContain('No line-level hunks');
    expect(req.context).not.toContain("Git's own files also differ");
    expect(req.options[0]).not.toHaveProperty('description');
    accepted(req);
  });
});

describe('one file', () => {
  test('a delete side with no lines still yields a description the route accepts', () => {
    const req = one({ path: '/a.txt', kind: 'content', hunks: [{ line: 3, ours: [], theirs: ['kept'] }] });
    expect(req.options[0].description).toBe('(empty)');
    accepted(req);
  });

  test('sides that differ only in indentation look different in the card and its options', () => {
    const req = one({ path: '/indent.js', kind: 'content', hunks: [{ line: 7, ours: ['    return x'], theirs: ['return x'] }] });
    expect(req.options[0].description).toBe('····return x');
    expect(req.options[1].description).toBe('return x');
    expect(req.context).toContain('main: ····return x');
    expect(req.context).toContain('agent-b: return x');
    accepted(req);
  });

  test('modify/delete: the theirs option says theirs deleted the file, so picking it is not silent', () => {
    const req = one({ path: '/a.txt', kind: 'modify/delete', hunks: [{ line: 1, ours: ['kept text'], theirs: [] }] });
    expect(req.question).toBe('agent-b deleted /a.txt:1, and main changed it. Which should land?');
    expect(req.options[0].description).toBe('kept text');
    expect(req.options[1].description).toBe('Delete /a.txt: agent-b deleted it.');
    accepted(req);
  });

  test('delete/modify: the ours option says ours deleted the file', () => {
    const req = one({ path: '/a.txt', kind: 'delete/modify', hunks: [{ line: 1, ours: [], theirs: ['kept'] }] });
    expect(req.question).toBe('main deleted /a.txt:1, and agent-b changed it. Which should land?');
    expect(req.options[0].description).toBe('Delete /a.txt: main deleted it.');
    expect(req.options[1].description).toBe('kept');
    accepted(req);
  });

  test('a delete with no text to keep still gives the deleting side its description', () => {
    const req = one({ path: '/gone.bin', kind: 'modify/delete', hunks: [] });
    expect(req.options[0]).not.toHaveProperty('description');
    expect(req.options[1].description).toBe('Delete /gone.bin: agent-b deleted it.');
    accepted(req);
  });

  test('sides with several non-empty lines keep every line in the context and the options', () => {
    const req = one({
      path: '/README.md',
      kind: 'content',
      hunks: [{
        line: 115,
        ours: ['Install with npm i -g commonly.', 'Run commonly from the workspace.'],
        theirs: ['Install with pnpm add -g commonly.', 'Run commonly from the workspace.'],
      }],
    });
    expect(req.context).toContain('main: Install with npm i -g commonly.\nRun commonly from the workspace.');
    expect(req.options[1].description).toBe('Install with pnpm add -g commonly.\nRun commonly from the workspace.');
  });

  test('a literal middle dot or arrow is not mistaken for drawn whitespace', () => {
    const req = one({ path: '/w.txt', kind: 'content', hunks: [{ line: 1, ours: [' return x'], theirs: ['·return x'] }] });
    expect(req.options[0].description).toBe('·return x');
    expect(req.options[1].description).toBe('\\u00b7return x');
    accepted(req);
  });

  test('trailing spaces and tab indentation are drawn, so each side shows what it changed', () => {
    const req = one({ path: '/ws.txt', kind: 'content', hunks: [{ line: 4, ours: ['x  '], theirs: ['\tfoo'] }] });
    expect(req.options[0].description).toBe('x··');
    expect(req.options[1].description).toBe('→foo');
    accepted(req);
  });

  test('clips long sides, so a huge line cannot blow the description limit', () => {
    const long = 'x'.repeat(5000);
    const req = one({ path: '/a.txt', kind: 'content', hunks: [{ line: 1, ours: [long], theirs: [long] }] });
    req.options.slice(0, 2).forEach((o) => expect(o.description.length).toBeLessThanOrEqual(201));
    accepted(req);
  });

  test('five long hunks stay inside the context limit, and the cut is named', () => {
    const block = 'y'.repeat(400);
    const hunks = Array.from({ length: 5 }, (_, i) => ({ line: i + 1, ours: [block], theirs: [block] }));
    const req = one({ path: '/big.md', kind: 'content', blocks: 5, hunks });
    expect(req.context).toMatch(/\[\d+ more hunks not shown\]$/);
    expect(req.context).toContain('File /big.md (content, 5 conflict blocks)');
    accepted(req);
  });

  test('an omitted content conflict is not read as binary', () => {
    const req = one({ path: '/big.md', kind: 'content', blocks: 9, hunksOmitted: true, hunks: [] });
    expect(req.context).toContain('Some hunks were omitted by the merge.');
    expect(req.context).not.toContain('No line-level hunks');
  });
});

describe('branch names', () => {
  test('long names that share a prefix stay whole in the context', () => {
    const shared = 'feature/checkout-redesign-experiment-';
    const req = one({ path: '/a.bin', kind: 'binary', hunks: [] }, { ours: `${shared}alpha`, theirs: `${shared}beta` });
    expect(req.context).toContain(`${shared}alpha (ours)`);
    expect(req.context).toContain(`${shared}beta (theirs)`);
  });

  test('names that differ only by case still give options the route accepts', () => {
    const req = one({ path: '/a.txt', kind: 'content', hunks: [{ line: 1, ours: ['a'], theirs: ['b'] }] }, { ours: 'Main', theirs: 'main' });
    expect(new Set(req.options.map((o) => o.label.toLowerCase())).size).toBe(3);
    accepted(req);
  });

  test('a long path and long names are clipped to every route limit', () => {
    const path = `/${'deep/'.repeat(60)}file.md`;
    const req = mergeConflictToDecisionRequest(refusal(
      [{ path, kind: 'content', hunks: [{ line: 12, ours: ['o'], theirs: ['t'] }] }, { ...readme, path: `${path}2` }],
      { ours: 'b'.repeat(200), theirs: 'c'.repeat(200) },
    ));
    accepted(req);
  });
});
