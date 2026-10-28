/**
 * TASK-597 (D155): a merge Conflict from a workspace branch becomes the
 * decision request an agent raises. The request must pass the same checks the
 * decision route applies, or the agent's card is refused at the door.
 *
 * The conflict fixture is the shape measured on walk-1028 (LayerFS 582bc786f9):
 * detail.conflicts[] with per-hunk line numbers and both sides as line arrays.
 */
const { conflictToDecisionRequest } = require('../../../services/workspaceConflictCard');
const { normalizeDecisionClass } = require('../../../services/decisionRequestService');

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
    expect(req.options.map((o) => o.label)).toEqual(['Keep main', 'Keep agent-b', 'Write the merged text']);
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

  test('a binary conflict with no hunks, such as /.git/index, names the file alone', () => {
    const req = conflictToDecisionRequest({ path: '/.git/index', kind: 'binary', hunks: [] }, sides);
    expect(req.title).toBe('Merge conflict in /.git/index');
    expect(req.options[0].description).toBe('');
  });
});
