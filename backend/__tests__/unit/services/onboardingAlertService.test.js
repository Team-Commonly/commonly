// Onboarding-silence DELIVERY (W4 item 2).
//
// Detection is tested next door. This file is about the half that can fail
// quietly: an alert that computes correctly and tells nobody is the exact
// shape of the three "silent success" defects found on 2026-08-14, and it is
// the worst place in the codebase to add a fourth. So the behaviours asserted
// here are mostly about refusing to be inert.

const mockScan = jest.fn();
jest.mock('../../../services/onboardingSilenceService', () => ({
  scan: (...a) => mockScan(...a),
  SILENCE_THRESHOLD_MINUTES: 15,
  ROLLUP_COLLAPSE_THRESHOLD: 5,
}));

const mockSendEmail = jest.fn();
jest.mock('../../../services/emailService', () => ({ sendEmail: (...a) => mockSendEmail(...a) }));

const mockCount = jest.fn();
const mockUpdateOne = jest.fn();
const mockUpdateMany = jest.fn();
jest.mock('../../../models/OnboardingSilenceEpisode', () => ({
  countDocuments: (...a) => mockCount(...a),
  updateOne: (...a) => mockUpdateOne(...a),
  updateMany: (...a) => mockUpdateMany(...a),
}));

const { runOnce, diagnose } = require('../../../services/onboardingAlertService');

const episode = (over = {}) => ({
  episodeId: 'ep1',
  userId: 'u1',
  username: 'newcomer',
  podId: 'p1',
  podName: 'My Workspace',
  firstMessageId: '900',
  firstTypedAt: new Date('2026-08-15T11:30:00Z'),
  accountAgeMinutes: 12,
  messageCount: 2,
  eventSnapshot: {
    total: 0, byStatus: {}, targets: [], noneEnqueued: true, runsStarted: 0,
  },
  ...over,
});

const emptyScan = {
  scannedMessages: 0, opened: [], updated: 0, resolved: [], skippedNoAgent: 0,
};

let errSpy;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ONBOARDING_ALERT_EMAIL;
  mockCount.mockResolvedValue(1);
  mockUpdateOne.mockResolvedValue({});
  mockUpdateMany.mockResolvedValue({});
  mockSendEmail.mockResolvedValue({});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe('onboardingAlertService.runOnce', () => {
  it('sends one email per stranded user', async () => {
    process.env.ONBOARDING_ALERT_EMAIL = 'ops@example.com';
    mockScan.mockResolvedValue({ ...emptyScan, opened: [episode(), episode({ episodeId: 'ep2', username: 'other' })] });

    const r = await runOnce();

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(r.delivered).toBe(2);
    expect(r.rollup).toBe(false);
    expect(mockSendEmail.mock.calls[0][0].to).toBe('ops@example.com');
    expect(mockSendEmail.mock.calls[0][0].subject).toContain('newcomer');
  });

  it('collapses into one rollup above the hourly threshold', async () => {
    process.env.ONBOARDING_ALERT_EMAIL = 'ops@example.com';
    mockScan.mockResolvedValue({
      ...emptyScan,
      opened: [episode(), episode({ episodeId: 'ep2' }), episode({ episodeId: 'ep3' })],
    });
    mockCount.mockResolvedValue(9); // pressure from this pass plus earlier ones

    const r = await runOnce();

    expect(r.rollup).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].textBody).toContain('9 in the last hour');
    expect(mockUpdateMany).toHaveBeenCalled();
  });

  it('counts rolling-hour pressure from the DB, not just this pass', async () => {
    process.env.ONBOARDING_ALERT_EMAIL = 'ops@example.com';
    mockScan.mockResolvedValue({ ...emptyScan, opened: [episode()] });
    mockCount.mockResolvedValue(20); // a burst spread across earlier ticks

    const r = await runOnce();

    expect(r.rollup).toBe(true);
  });

  it('says so loudly when no recipient is configured, instead of silently dropping', async () => {
    mockScan.mockResolvedValue({ ...emptyScan, opened: [episode()] });

    const r = await runOnce();

    expect(r.unconfigured).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
    const shouted = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(shouted).toContain('NO ALERT RECIPIENT IS CONFIGURED');
    expect(shouted).toContain('ONBOARDING_ALERT_EMAIL');
  });

  it('still emits the machine-readable line when email is unconfigured', async () => {
    mockScan.mockResolvedValue({ ...emptyScan, opened: [episode()] });

    await runOnce();

    const logged = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('[onboarding-silence] ALERT');
    expect(logged).toContain('user=newcomer');
    expect(logged).toContain('delivery=log-only');
  });

  it('does not mark an episode alerted when the send throws', async () => {
    process.env.ONBOARDING_ALERT_EMAIL = 'ops@example.com';
    mockScan.mockResolvedValue({ ...emptyScan, opened: [episode()] });
    mockSendEmail.mockRejectedValue(new Error('smtp down'));

    const r = await runOnce();

    expect(r.delivered).toBe(0);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('stays quiet when nothing is stranded', async () => {
    process.env.ONBOARDING_ALERT_EMAIL = 'ops@example.com';
    mockScan.mockResolvedValue(emptyScan);

    const r = await runOnce();

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(r.delivered).toBe(0);
    expect(r.unconfigured).toBe(false);
  });
});

describe('diagnose', () => {
  // This is the whole reason the snapshot is taken before the 30-minute GC:
  // these two point at opposite fixes and are indistinguishable afterwards.
  it('names a producer bug when nothing was ever enqueued', () => {
    expect(diagnose(episode())).toBe('never-enqueued');
  });

  it('names a runtime bug when the queue had work and nothing answered', () => {
    expect(diagnose(episode({
      eventSnapshot: {
        total: 1, byStatus: { pending: 1 }, targets: ['scout/u1'], noneEnqueued: false, runsStarted: 0,
      },
    }))).toBe('enqueued-never-answered');
  });

  // An acked event with no reply is NOT one fault, and collapsing the two
  // would report a declined-at-cap runtime as a broken one. ADR-022 D5 makes
  // at-cap more common, so the bucket would get less accurate over time.
  it('separates "acked but never ran" from "ran and stayed silent"', () => {
    const acked = (runsStarted) => episode({
      eventSnapshot: {
        total: 1, byStatus: { acked: 1 }, targets: ['scout/u1'], noneEnqueued: false, runsStarted,
      },
    });
    // No AgentRun row: declined at the daily cap (which returns `succeeded`
    // before writing one) or lost the claim to a peer. Never started.
    expect(diagnose(acked(0))).toBe('acked-never-ran');
    // A run exists: it started and produced nothing. Different investigation.
    expect(diagnose(acked(2))).toBe('ran-but-silent');
  });

  it('reports unknown rather than guessing when no snapshot survives', () => {
    expect(diagnose(episode({ eventSnapshot: undefined }))).toBe('unknown');
  });
});
