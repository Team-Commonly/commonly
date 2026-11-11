/**
 * F440: which stored rows the platform wrote. They sit under the account they
 * are about or speak for, and that account gets no author rights over them.
 */
const { platformAuthoredKind } = require('../../../services/platformAuthoredMessage');

describe('platformAuthoredKind', () => {
  test('a system line is the platform\'s, under its own code', () => {
    expect(platformAuthoredKind({ message_type: 'system' })).toBe('system_line');
  });

  test('an approval card is the platform\'s', () => {
    expect(platformAuthoredKind({ message_type: 'card', payload: { kind: 'approval', approvalId: 'a1' } }))
      .toBe('platform_post');
  });

  test('a card whose payload arrives as JSON text is read the same way', () => {
    expect(platformAuthoredKind({ message_type: 'card', payload: '{"kind":"approval"}' })).toBe('platform_post');
  });

  test('a card with no payload is not one an agent could have posted', () => {
    expect(platformAuthoredKind({ message_type: 'card' })).toBe('platform_post');
  });

  test('a kernel intro or nudge is the platform\'s, whatever its type', () => {
    expect(platformAuthoredKind({ message_type: 'text', author_kind: 'kernel' })).toBe('platform_post');
  });

  test('a "starts" prompt the platform writes as text is the platform\'s', () => {
    expect(platformAuthoredKind({ message_type: 'text', payload: { kind: 'starts', starts: [] } }))
      .toBe('platform_post');
  });

  test('an agent reply a native run stamped with its run is the agent\'s', () => {
    expect(platformAuthoredKind({ message_type: 'text', payload: { runId: 'r1', runPodId: 'p1' } })).toBeNull();
  });

  test('the same stamp on a starts prompt still marks the platform\'s', () => {
    expect(platformAuthoredKind({
      message_type: 'text', payload: { kind: 'starts', starts: [], runId: 'r1', runPodId: 'p1' },
    })).toBe('platform_post');
  });

  test('a text row with no payload is its author\'s', () => {
    expect(platformAuthoredKind({ message_type: 'text', payload: null })).toBeNull();
  });

  test('the ui card an agent posts itself is the agent\'s', () => {
    expect(platformAuthoredKind({ message_type: 'card', payload: { kind: 'ui', v: 1, lang: 'openui@1' } })).toBeNull();
  });

  test('an ordinary message is its author\'s', () => {
    expect(platformAuthoredKind({ message_type: 'text', author_kind: null })).toBeNull();
    expect(platformAuthoredKind({ message_type: 'image' })).toBeNull();
    expect(platformAuthoredKind(null)).toBeNull();
  });
});
