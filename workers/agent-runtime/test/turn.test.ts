import { describe, it, expect } from 'vitest';
import { convertToLlm, lastAssistantText, tailBound } from '../src/turn';

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as never;
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 }) as never;

describe('turn helpers', () => {
  it('convertToLlm keeps LLM messages and drops custom agent messages, never throws', () => {
    const out = convertToLlm([user('a'), { role: 'custom', customType: 'ui' } as never, assistant('b'), null as never]);
    expect(out.map((m) => (m as { role: string }).role)).toEqual(['user', 'assistant']);
  });

  it('lastAssistantText returns the final assistant text, joining text blocks', () => {
    const msgs = [user('q'), assistant('first'), user('q2'), { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } as never];
    expect(lastAssistantText(msgs)).toBe('ab');
    expect(lastAssistantText([user('only')])).toBe('');
  });

  it('tailBound drops from the oldest end at user-message boundaries until under budget', () => {
    const msgs = [user('1'), assistant('1'), user('2'), assistant('2'), user('3'), assistant('3')];
    // pretend each message costs 10 tokens; budget allows 4 messages
    const out = tailBound(msgs, 40, (m) => m.length * 10);
    expect(out).toHaveLength(4);
    expect((out[0] as { role: string }).role).toBe('user');
  });

  it('tailBound never drops below the last two messages', () => {
    const msgs = [user('1'), assistant('1'), user('2'), assistant('2')];
    expect(tailBound(msgs, 1, (m) => m.length * 10)).toHaveLength(2);
  });
});
