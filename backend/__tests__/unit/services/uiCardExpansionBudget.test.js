const mockMaterialize = jest.fn(() => { throw new Error('materializer must not run'); });
jest.mock('@openuidev/lang-core', () => ({
  ...jest.requireActual('@openuidev/lang-core'),
  createParser: () => ({ parse: mockMaterialize }),
}));
const { validateAgentCardPayload } = require('../../../services/uiCardValidation');
const revision = require('../../../config/uiCardCatalogueRevision.json');
const validate = (source) => validateAgentCardPayload('card', {
  ...revision, kind: 'ui', v: 1, lang: 'openui@1', source,
}, 'Text fallback');

describe('reference budgets run before materialization', () => {
  const sixWay = (dormant) => {
    const lines = ['a0 = Text("leaf")'];
    for (let level = 1; level <= 12; level += 1) {
      lines.push(`a${level} = Card("repeat", [${Array(6).fill(`a${level - 1}`).join(',')}])`);
    }
    lines.push(dormant ? 'root = Text("safe")' : 'root = a12');
    return lines.join('\n');
  };
  it.each([false, true])('refuses exponential six-way expansion, including dormant=%s', (dormant) => {
    expect(() => validate(sixWay(dormant))).toThrow('reference expansion budget');
    expect(mockMaterialize).not.toHaveBeenCalled();
  });
  it('refuses a long alias chain before recursive materialization', () => {
    const lines = ['root = a140', 'a0 = Text("leaf")'];
    for (let i = 1; i <= 140; i += 1) lines.push(`a${i} = a${i - 1}`);
    expect(() => validate(lines.join('\n'))).toThrow('reference expansion budget');
    expect(mockMaterialize).not.toHaveBeenCalled();
  });
  it('allows exactly 2048 expanded nodes to reach the materializer', () => {
    const source = 'root = Text("safe")\nunused = [' + Array(2045).fill('null').join(',') + ']';
    expect(() => validate(source)).toThrow('could not be parsed');
    expect(mockMaterialize).toHaveBeenCalledTimes(1);
  });
  it('rejects the first node beyond the budget before materialization', () => {
    const source = 'root = Text("safe")\nunused = [' + Array(2046).fill('null').join(',') + ']';
    expect(() => validate(source)).toThrow('reference expansion budget');
    expect(mockMaterialize).not.toHaveBeenCalled();
  });
});
