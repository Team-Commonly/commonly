/**
 * The pod-context cue (#1216/#1244) tells agents, in the frame they receive on
 * every wake: "human attention is matched on the literal @handle, so 'Sam
 * should decide this' is addressed to nobody."
 *
 * That is a claim about THIS function and nothing else. An agent cannot
 * falsify it — it acts on the cue and never sees the code. Before this file,
 * nothing did either: dropping the '@' from `mentionNeedle` left all 2033
 * backend unit tests green (measured at origin/main e86a4a4a, twice, with an
 * unmutated 2033/2033 control). The cue would have become a lie with its own
 * text untouched and the suite still passing.
 *
 * So this pins the BEHAVIOUR, not the copy. The negative is the load-bearing
 * case; each one is paired with the positive that proves the fixture reaches
 * the branch at all.
 */
const ActivityService = require('../../../services/activityService');

const flagsFor = (content, username) => ActivityService.computeFlags({
  actor: { id: 'u1', type: 'user' },
  type: 'message',
  action: 'posted',
  content,
  username,
});

describe('human mentions are matched on the literal @handle', () => {
  it('a bare name is NOT a mention — the cue\'s central claim', () => {
    expect(flagsFor('Sam should decide this', 'sam').isMention).toBe(false);
  });

  it('CONTROL: the same sentence with the handle IS a mention', () => {
    expect(flagsFor('@sam should decide this', 'sam').isMention).toBe(true);
  });

  it('the @ must be adjacent — "@ sam" does not address sam', () => {
    expect(flagsFor('@ sam should decide this', 'sam').isMention).toBe(false);
  });

  it('matching is case-insensitive on both sides', () => {
    expect(flagsFor('Ping @SAM about this', 'Sam').isMention).toBe(true);
  });

  it('an empty username never matches, however the content reads', () => {
    expect(flagsFor('@ everyone @', '').isMention).toBe(false);
  });

  it('the handle is found mid-sentence, not just at the start', () => {
    expect(flagsFor('I think @sam owns this one', 'sam').isMention).toBe(true);
  });

  /**
   * Documented over-match, pinned so the next reader sees it is known rather
   * than believing the handle is matched as a whole token. `includes` has no
   * right boundary, so a longer handle contains a shorter one. Reported
   * separately; this test records the behaviour, it does not endorse it.
   */
  it('KNOWN OVER-MATCH: a longer handle flags the shorter one it contains', () => {
    expect(flagsFor('@sammy is on it', 'sam').isMention).toBe(true);
  });
});
