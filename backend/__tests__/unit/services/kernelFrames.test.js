/**
 * The kernel's mention frames have one owner (kernelFrames), so a driver that
 * rewrites a frame for its own tools finds it by tag instead of parsing prose.
 *
 * Contract under test:
 *  - leading frame lines split from the message, and rejoin to the same text
 *  - an untagged frame is still a frame; its tag is null
 *  - content that does not open with a frame block comes back whole
 */

const fs = require('fs');
const path = require('path');
const {
  KERNEL_FRAME_TAGS, frameTagOf, joinKernelFrames, splitKernelFrames,
} = require('../../../services/kernelFrames');

const framed = [
  `[${KERNEL_FRAME_TAGS.podContext}: this conversation is in pod \`p1\`.]`,
  `[${KERNEL_FRAME_TAGS.trigger}: this turn was raised by **alice**.]`,
  '[This message replies to YOUR earlier message.]',
].join('\n');

describe('kernelFrames', () => {
  test('splits the frames from the message and rejoins to the same text', () => {
    const content = `${framed}\n\nhi @seat-a\n\nsecond paragraph`;
    const { frames, body } = splitKernelFrames(content);

    expect(frames.map(frameTagOf)).toEqual(['Pod context', 'Trigger', null]);
    expect(body).toBe('hi @seat-a\n\nsecond paragraph');
    expect(joinKernelFrames(frames, body)).toBe(content);
  });

  test.each([
    ['no frames', 'hi @seat-a'],
    ['a bracketed message with no blank line', '[draft] hi @seat-a'],
    ['a block whose second line is prose', '[Pod context: p1.]\nnot a frame\n\nhi'],
    ['an empty string', ''],
  ])('%s comes back whole', (_label, content) => {
    expect(splitKernelFrames(content)).toEqual({ frames: [], body: content });
    expect(joinKernelFrames([], content)).toBe(content);
  });

  test.each(Object.entries(KERNEL_FRAME_TAGS))('the %s tag is the one agentMentionService writes', (_key, tag) => {
    const source = fs.readFileSync(path.join(__dirname, '../../../services/agentMentionService.ts'), 'utf8');
    expect(source).toContain(`[${tag}: `);
  });

  test('frameTagOf reads the tag before the first colon', () => {
    expect(frameTagOf('[Reply mechanics: post it.]')).toBe('Reply mechanics');
    expect(frameTagOf('[This message replies to YOUR earlier message — you are addressed.]')).toBeNull();
    expect(frameTagOf('plain text')).toBeNull();
  });
});
