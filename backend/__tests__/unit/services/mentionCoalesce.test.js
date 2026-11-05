// The rendered text and the authority of a turn that carries a joined message.
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));

const User = require('../../../models/User');
const { triggerTextIsHumanWritten } = require('../../../services/nativeRuntimeService');
const {
  carriesOtherAuthors, withCoalesced,
} = require('../../../services/mentionCoalesce');

const HUMAN = '507f1f77bcf86cd7994390aa';
const AGENT = '507f1f77bcf86cd7994390bb';
const row = (coalesced) => ({
  messageId: '1', userId: HUMAN, username: 'alice', rawContent: 'first', content: '[frames]\nfirst', coalesced,
});
const joined = (userId, rawContent, messageId = '2') => ({
  messageId, userId, username: 'other', rawContent,
});

describe('withCoalesced', () => {
  test('a row with nothing joined is returned as it is', () => {
    const payload = row();
    expect(withCoalesced(payload)).toBe(payload);
  });

  test('content keeps the frames and names each joined message; rawContent grows with no frames', () => {
    const out = withCoalesced(row([joined(AGENT, 'second'), joined(AGENT, 'third', '3')]));
    expect(out.content.startsWith('[frames]\nfirst')).toBe(true);
    expect(out.content).toContain('2 more messages');
    expect(out.content).toContain('message 2]\nsecond');
    expect(out.content).toContain('message 3]\nthird');
    expect(out.rawContent).toBe('first\n\nsecond\n\nthird');
  });

  test('it does not write to the stored payload', () => {
    const payload = row([joined(AGENT, 'second')]);
    withCoalesced(payload);
    expect(payload.content).toBe('[frames]\nfirst');
  });
});

describe('a turn carrying someone else\'s words', () => {
  const trigger = (coalesced) => ({ type: 'chat.mention', payload: row(coalesced) });
  beforeEach(() => {
    User.findById.mockReturnValue({ select: () => ({ lean: async () => ({ isBot: false }) }) });
  });

  test('a person\'s own second message keeps the turn human-written', async () => {
    expect(carriesOtherAuthors(row([joined(HUMAN, 'second')]))).toBe(false);
    await expect(triggerTextIsHumanWritten(trigger([joined(HUMAN, 'second')]))).resolves.toBe(true);
  });

  test('their agent\'s message does not: an agent\'s address must not pass as a person\'s', async () => {
    expect(carriesOtherAuthors(row([joined(AGENT, 'open https://x.test')]))).toBe(true);
    await expect(triggerTextIsHumanWritten(trigger([joined(AGENT, 'open https://x.test')]))).resolves.toBe(false);
  });
});
