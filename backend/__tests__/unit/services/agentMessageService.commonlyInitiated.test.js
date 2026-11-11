// F447: which stored rows are Commonly speaking on its own under a seat.
const AgentMessageService = require('../../../services/agentMessageService');

describe('isCommonlyInitiated', () => {
  it.each([
    ['a kernel text post (PG shape)', { author_kind: 'kernel', message_type: 'text' }, true],
    ['a kernel text post (normalized shape)', { author_kind: 'kernel', messageType: 'text' }, true],
    ['a kernel post with no type', { author_kind: 'kernel' }, true],
    ['the setup card: kernel, but the agent chose it', { author_kind: 'kernel', messageType: 'card' }, false],
    ['the setup card, upper-case type', { author_kind: 'kernel', message_type: 'CARD' }, false],
    ['the agent\'s own post', { author_kind: null, messageType: 'text' }, false],
    ['the agent\'s own card', { messageType: 'card' }, false],
    ['nothing', null, false],
  ])('%s', (_label, row, expected) => {
    expect(AgentMessageService.isCommonlyInitiated(row)).toBe(expected);
  });
});
