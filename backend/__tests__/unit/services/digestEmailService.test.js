const mockSendEmail = jest.fn();
jest.mock('../../../services/emailService', () => ({
  sendEmail: mockSendEmail,
}));
// testUtils imports jsonwebtoken, whose transitive constant-time package is
// incompatible with Node 26's removed SlowBuffer. No JWT behavior is used here.
jest.mock('jsonwebtoken', () => ({}));

const User = require('../../../models/User');
const Summary = require('../../../models/Summary');
const digestEmailService = require('../../../services/digestEmailService');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

let sequence = 0;

const createUser = async ({ verified = true, dailyDigest } = {}) => {
  sequence += 1;
  const values = {
    username: `digest-user-${sequence}`,
    email: `digest-${sequence}@example.com`,
    password: 'Password123!',
    verified,
  };
  if (dailyDigest !== undefined) {
    values.emailPreferences = { dailyDigest };
  }
  return User.create(values);
};

const createDigest = (user, totalItems = 3, content = '- First update\n- Second update') => Summary.create({
  type: 'daily-digest',
  title: `Daily Digest for ${user.username}`,
  content,
  timeRange: { start: new Date(Date.now() - 3600000), end: new Date() },
  metadata: { totalItems, userId: String(user._id) },
});

const runEntry = (digest) => ({ success: true, digest });

describe('digestEmailService', () => {
  const originalEnv = process.env;

  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    process.env = originalEnv;
    await closeMongoDb();
  });

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SMTP2GO_API_KEY: 'smtp-key',
      SMTP2GO_FROM_EMAIL: 'hello@commonly.me',
      FRONTEND_URL: 'https://commonly.me',
      BACKEND_URL: 'https://api.commonly.me',
    };
    mockSendEmail.mockReset().mockResolvedValue({ data: { data: { succeeded: 1 } } });
  });

  afterEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
  });

  it('emails a non-empty digest to a verified default-on user and stamps it', async () => {
    const user = await createUser();
    const digest = await createDigest(user, 2, '- <script>alert(1)</script>\n- A useful update');

    const result = await digestEmailService.sendDigestEmails([runEntry(digest)]);

    expect(result).toEqual(expect.objectContaining({ eligible: 1, sent: 1, failed: 0 }));
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: user.email,
      subject: digest.title,
      textBody: expect.stringContaining('https://commonly.me/v2'),
      htmlBody: expect.stringContaining('https://api.commonly.me/api/email/unsubscribe/'),
    }));
    expect(mockSendEmail.mock.calls[0][0].htmlBody).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mockSendEmail.mock.calls[0][0].htmlBody).not.toContain('<script>alert(1)</script>');

    const freshDigest = await Summary.findById(digest._id);
    expect(freshDigest.metadata.emailedAt).toBeInstanceOf(Date);
    const freshUser = await User.findById(user._id).select('+digestUnsubscribeToken');
    expect(freshUser.emailPreferences.dailyDigest).toBe(true);
    expect(freshUser.digestUnsubscribeToken).toMatch(/^[a-f0-9]{48}$/);
  });

  it('never sends an empty digest', async () => {
    const user = await createUser();
    const digest = await createDigest(user, 0);

    const result = await digestEmailService.sendDigestEmails([runEntry(digest)]);

    expect(result).toEqual(expect.objectContaining({ eligible: 0, sent: 0 }));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('skips unverified and unsubscribed users', async () => {
    const unverified = await createUser({ verified: false });
    const unsubscribed = await createUser({ dailyDigest: false });
    const digests = await Promise.all([
      createDigest(unverified),
      createDigest(unsubscribed),
    ]);

    const result = await digestEmailService.sendDigestEmails(digests.map(runEntry));

    expect(result).toEqual(expect.objectContaining({ eligible: 2, sent: 0, skipped: 2 }));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('does not send a stamped digest again when the same run is retried', async () => {
    const user = await createUser();
    const digest = await createDigest(user);
    const currentRun = [runEntry(digest)];

    await digestEmailService.sendDigestEmails(currentRun);
    await digestEmailService.sendDigestEmails(currentRun);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not sweep an older unemailed digest outside the current run', async () => {
    const user = await createUser();
    const historicalDigest = await createDigest(user, 2, '- Yesterday');
    const currentDigest = await createDigest(user, 2, '- Today');

    await digestEmailService.sendDigestEmails([runEntry(currentDigest)]);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect((await Summary.findById(historicalDigest._id)).metadata.emailedAt).toBeUndefined();
    expect((await Summary.findById(currentDigest._id)).metadata.emailedAt).toBeInstanceOf(Date);
  });

  it('continues to later users when one email fails', async () => {
    const firstUser = await createUser();
    const secondUser = await createUser();
    const firstDigest = await createDigest(firstUser);
    const secondDigest = await createDigest(secondUser);
    mockSendEmail.mockImplementation(({ to }) => (
      to === firstUser.email
        ? Promise.reject(new Error('SMTP rejected recipient'))
        : Promise.resolve({ data: { data: { succeeded: 1 } } })
    ));

    const result = await digestEmailService.sendDigestEmails([
      runEntry(firstDigest),
      runEntry(secondDigest),
    ]);

    expect(result).toEqual(expect.objectContaining({ sent: 1, failed: 1 }));
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect((await Summary.findById(firstDigest._id)).metadata.emailedAt).toBeUndefined();
    expect((await Summary.findById(secondDigest._id)).metadata.emailedAt).toBeInstanceOf(Date);
  });

  it('logs once and skips the entire run when SMTP is unconfigured', async () => {
    delete process.env.SMTP2GO_API_KEY;
    const user = await createUser();
    const digest = await createDigest(user);

    await expect(digestEmailService.sendDigestEmails([runEntry(digest)]))
      .resolves.toEqual(expect.objectContaining({ unconfigured: true, sent: 0 }));

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('also treats a missing sender address as unconfigured', async () => {
    delete process.env.SMTP2GO_FROM_EMAIL;
    const user = await createUser();
    const digest = await createDigest(user);

    await expect(digestEmailService.sendDigestEmails([runEntry(digest)]))
      .resolves.toEqual(expect.objectContaining({ unconfigured: true, sent: 0 }));

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
