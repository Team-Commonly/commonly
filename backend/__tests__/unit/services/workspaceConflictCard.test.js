/**
 * TASK-597 (D155): a merge Conflict from a workspace branch becomes the
 * decision request an agent raises. The request must pass the same checks the
 * decision route applies, or the agent's card is refused at the door.
 *
 * The conflict fixture is the Conflict shape LayerFS 582bc786f9 returns:
 * detail.conflicts[] with per-hunk line numbers and both sides as line arrays.
 */
const { conflictToDecisionRequest } = require('../../../services/workspaceConflictCard');
const { normalizeDecisionClass, normalizeOptions } = require('../../../services/decisionRequestService');

const conflict = {
  path: '/README.md',
  kind: 'content',
  blocks: 1,
  hunksOmitted: false,
  hunks: [{
    line: 115,
    ours: ['Install with npm i -g commonly.', ''],
    theirs: ['Install with pnpm add -g commonly.', ''],
  }],
};
const sides = { base: 'main', branch: 'agent-b' };

describe('conflictToDecisionRequest', () => {
  test('names the path, the line, the kind and both sides\' lines', () => {
    const req = conflictToDecisionRequest(conflict, sides);
    expect(req.title).toBe('Merge conflict in /README.md:115');
    expect(req.question).toMatch(/agent-b and main both changed \/README\.md:115/);
    expect(req.context).toContain('Conflict kind: content');
    expect(req.context).toContain('main: Install with npm i -g commonly.');
    expect(req.context).toContain('agent-b: Install with pnpm add -g commonly.');
  });

  test('offers one option per side and one to write the text, and passes the decision route\'s checks', () => {
    const req = conflictToDecisionRequest(conflict, sides);
    expect(req.options.map((o) => o.label)).toEqual(['Keep base (main)', 'Keep branch (agent-b)', 'Write the merged text']);
    expect(req.options.length).toBeGreaterThanOrEqual(2);
    expect(req.options.length).toBeLessThanOrEqual(4);
    expect(new Set(req.options.map((o) => o.label)).size).toBe(req.options.length);
    req.options.forEach((o) => {
      expect(o.label.length).toBeLessThanOrEqual(80);
      expect(o.description.length).toBeLessThanOrEqual(280);
    });
    expect(normalizeDecisionClass(req.decisionClass)).toBe('implementation');
  });

  test('clips long sides, so a huge line cannot blow the description limit', () => {
    const long = 'x'.repeat(5000);
    const req = conflictToDecisionRequest({ ...conflict, hunks: [{ line: 1, ours: [long], theirs: [long] }] }, sides);
    req.options.slice(0, 2).forEach((o) => expect(o.description.length).toBeLessThanOrEqual(201));
    expect(req.context.length).toBeLessThan(1000);
  });

  test('a binary conflict with no hunks, such as /.git/index, is accepted by the decision route', () => {
    const req = conflictToDecisionRequest({ path: '/.git/index', kind: 'binary', hunks: [] }, sides);
    expect(req.title).toBe('Merge conflict in /.git/index');
    expect(req.options[0]).not.toHaveProperty('description');
    expect(req.context).toContain('No line-level hunks');
    expect(() => normalizeOptions(req.options)).not.toThrow();
  });

  test('a delete side with no lines still yields a description the route accepts', () => {
    const req = conflictToDecisionRequest({
      path: '/a.txt',
      kind: 'content',
      hunks: [{ line: 3, ours: [], theirs: ['kept'] }],
    }, sides);
    expect(req.options[0].description).toBe('(empty)');
    expect(() => normalizeOptions(req.options)).not.toThrow();
  });

  test('sides that differ only in indentation look different in the card and its options', () => {
    const req = conflictToDecisionRequest({
      path: '/indent.js',
      kind: 'content',
      hunks: [{ line: 7, ours: ['    return x'], theirs: ['return x'] }],
    }, sides);
    expect(req.options[0].description).toBe('····return x');
    expect(req.options[1].description).toBe('return x');
    expect(req.context).toContain('main: ····return x');
    expect(req.context).toContain('agent-b: return x');
    expect(() => normalizeOptions(req.options)).not.toThrow();
  });

  test('trailing spaces and tab indentation are drawn, so each side shows what it changed', () => {
    const req = conflictToDecisionRequest({
      path: '/ws.txt',
      kind: 'content',
      hunks: [{ line: 4, ours: ['x  '], theirs: ['\tfoo'] }],
    }, sides);
    expect(req.options[0].description).toBe('x··');
    expect(req.options[1].description).toBe('→foo');
    expect(req.context).toContain('main: x··');
    expect(req.context).toContain('agent-b: →foo');
    expect(() => normalizeOptions(req.options)).not.toThrow();
  });

  test('side names that differ only by case still give options the route accepts', () => {
    const req = conflictToDecisionRequest({
      path: '/a.txt', kind: 'content', hunks: [{ line: 1, ours: ['a'], theirs: ['b'] }],
    }, { base: 'Main', branch: 'main' });
    expect(new Set(req.options.map((o) => o.label.toLowerCase())).size).toBe(3);
    expect(() => normalizeOptions(req.options)).not.toThrow();
  });

  test('five long hunks stay inside the context limit, and the cut is named', () => {
    const block = 'y'.repeat(400);
    const hunks = Array.from({ length: 5 }, (_, i) => ({ line: i + 1, ours: [block], theirs: [block] }));
    const req = conflictToDecisionRequest({ path: '/big.md', kind: 'content', blocks: 5, hunks }, sides);
    expect(req.context.length).toBeLessThanOrEqual(2000);
    expect(req.context).toMatch(/\[\d+ more hunks not shown\]$/);
    expect(req.context).toContain('Conflict blocks: 5');
  });

  test('blocks and hunksOmitted reach the agent, so an omitted content conflict is not read as binary', () => {
    const req = conflictToDecisionRequest({
      path: '/big.md', kind: 'content', blocks: 9, hunksOmitted: true, hunks: [],
    }, sides);
    expect(req.context).toContain('Conflict blocks: 9');
    expect(req.context).toContain('Some hunks were omitted by the merge.');
    expect(req.context).not.toContain('No line-level hunks');
  });

  test('a long path and long branch names are clipped to every route limit', () => {
    const path = `/${'deep/'.repeat(60)}file.md`;
    const longSides = { base: 'b'.repeat(200), branch: 'c'.repeat(200) };
    const req = conflictToDecisionRequest({
      path, kind: 'content', hunks: [{ line: 12, ours: ['o'], theirs: ['t'] }],
    }, longSides);
    expect(req.title.length).toBeLessThanOrEqual(160);
    expect(req.question.length).toBeLessThanOrEqual(1000);
    expect(req.context.length).toBeLessThanOrEqual(2000);
    expect(() => normalizeOptions(req.options)).not.toThrow();
    req.options.forEach((o) => expect(o.label.length).toBeLessThanOrEqual(80));
  });
});
