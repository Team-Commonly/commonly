/** F253: a skipped post must read as not posted to whoever made it. */
const { describeSkippedPost, isHeldBackPost } = require('../../../services/skippedPostGuidance');

describe('describeSkippedPost', () => {
  it('says nothing about a post that landed or was refused', () => {
    expect(describeSkippedPost({ success: true, message: { id: 1 } })).toBeNull();
    expect(describeSkippedPost({ success: false, refused: true, reason: 'consecutive_run_cap' })).toBeNull();
    expect(describeSkippedPost(null)).toBeNull();
  });

  it('names the earlier message on a duplicate and says what to do', () => {
    const { posted, guidance } = describeSkippedPost({
      success: true, skipped: true, reason: 'duplicate_recent', duplicate: { id: 130040, dedupeWindowMinutes: 30 },
    });
    expect(posted).toBe(false);
    expect(guidance).toMatch(/^Not posted/);
    expect(guidance).toContain('130040');
    expect(guidance).toMatch(/different words/);
  });

  it('makes no claim about who addressed the poster: it cannot know', () => {
    const { guidance } = describeSkippedPost({
      success: true, skipped: true, reason: 'duplicate_recent', duplicate: { id: 130040 },
    });
    expect(guidance).not.toMatch(/addressed/);
  });

  it.each(['duplicate_urls', 'silent_or_empty', 'heartbeat_housekeeping', 'runtime_timeout_suppressed', undefined])(
    'reads as not posted for %s',
    (reason) => {
      const skip = describeSkippedPost({ success: true, skipped: true, reason });
      expect(skip.posted).toBe(false);
      expect(skip.guidance).toMatch(/^Not posted/);
    },
  );
});

describe('isHeldBackPost', () => {
  it('holds back a real message the guard kept out, not a decline', () => {
    expect(isHeldBackPost({ skipped: true, reason: 'duplicate_recent' })).toBe(true);
    expect(isHeldBackPost({ skipped: true, reason: 'duplicate_urls' })).toBe(true);
    expect(isHeldBackPost({ skipped: true, reason: 'runtime_model_failure_suppressed' })).toBe(true);
    expect(isHeldBackPost({ skipped: true, reason: 'runtime_tool_failure_suppressed' })).toBe(true);
    expect(isHeldBackPost({ skipped: true, reason: 'silent_or_empty' })).toBe(false);
    expect(isHeldBackPost({ skipped: true })).toBe(false);
    expect(isHeldBackPost({ success: true })).toBe(false);
  });
});
