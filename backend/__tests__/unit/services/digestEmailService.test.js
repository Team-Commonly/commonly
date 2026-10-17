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
const SystemSetting = require('../../../models/SystemSetting');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

let sequence = 0;

const createUser = async ({ verified = true, dailyDigest, email } = {}) => {
  sequence += 1;
  const values = {
    username: `digest-user-${sequence}`,
    email: email || `digest-${sequence}@example.com`,
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

  // The first real run (2026-10-17 06:01Z) emailed a verified operator account on
  // a reserved .invalid domain. The digest record stays; only the email is skipped.
  it('skips a verified address on a reserved domain, keeps the digest, and still sends to an ordinary one', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const reserved = await createUser({ email: `ops-${sequence + 1}@ops.commonly.invalid` });
    const ordinary = await createUser({ email: `person-${sequence + 1}@gmail.com` });
    const reservedDigest = await createDigest(reserved);
    const ordinaryDigest = await createDigest(ordinary);

    const result = await digestEmailService.sendDigestEmails([runEntry(reservedDigest), runEntry(ordinaryDigest)]);

    expect(result).toEqual(expect.objectContaining({ eligible: 2, sent: 1, skipped: 1, failed: 0 }));
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe(ordinary.email);
    expect(await Summary.findById(reservedDigest._id)).not.toBeNull();
    expect((await Summary.findById(reservedDigest._id)).metadata.emailedAt).toBeUndefined();
    expect((await User.findById(reserved._id)).lastDigestSent).toBeUndefined();
    // Skipped before an unsubscribe token is minted for an address that can never
    // receive it (sprint-review on #2298: moving the guard below the mint stayed green).
    expect((await User.findById(reserved._id).select('+digestUnsubscribeToken')).digestUnsubscribeToken).toBeUndefined();
    // One line per skip, naming the user and never the address.
    const skipLogs = infoSpy.mock.calls.filter(([msg]) => /reserved domain/.test(String(msg)));
    expect(skipLogs).toHaveLength(1);
    expect(JSON.stringify(skipLogs[0])).toContain(String(reserved._id));
    expect(JSON.stringify(skipLogs[0])).not.toContain('commonly.invalid');
    infoSpy.mockRestore();
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
    expect(freshUser.lastDigestSent).toBeInstanceOf(Date);
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

  it('claims before SMTP and continues when one email fails without retrying it', async () => {
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
    expect((await Summary.findById(firstDigest._id)).metadata.emailedAt).toBeInstanceOf(Date);
    expect((await Summary.findById(secondDigest._id)).metadata.emailedAt).toBeInstanceOf(Date);
    expect((await User.findById(firstUser._id)).lastDigestSent).toBeUndefined();
    expect((await User.findById(secondUser._id)).lastDigestSent).toBeInstanceOf(Date);

    await digestEmailService.sendDigestEmails([
      runEntry(firstDigest),
      runEntry(secondDigest),
    ]);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  it('sets lastDigestSent only after SMTP accepts the message', async () => {
    const user = await createUser();
    const digest = await createDigest(user);
    let releaseSmtp;
    let smtpStarted;
    const enteredSmtp = new Promise((resolve) => { smtpStarted = resolve; });
    mockSendEmail.mockImplementation(() => new Promise((resolve) => {
      releaseSmtp = resolve;
      smtpStarted();
    }));

    const sending = digestEmailService.sendDigestEmails([runEntry(digest)]);
    await enteredSmtp;
    expect((await User.findById(user._id)).lastDigestSent).toBeUndefined();

    releaseSmtp({ data: { data: { succeeded: 1 } } });
    await sending;
    expect((await User.findById(user._id)).lastDigestSent).toBeInstanceOf(Date);
  });

  // The stop switch (2026-10-16): one system_settings row stops every send,
  // with no deploy. No row means on.
  it('sends nothing when the sending switch is off, and sends again when it is on', async () => {
    const user = await createUser();
    const digest = await createDigest(user);
    await SystemSetting.create({ key: digestEmailService.DIGEST_SENDING_KEY, value: { enabled: false } });

    await expect(digestEmailService.sendDigestEmails([runEntry(digest)]))
      .resolves.toEqual(expect.objectContaining({ disabled: true, sent: 0 }));
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect((await Summary.findById(digest._id)).metadata.emailedAt).toBeUndefined();

    await SystemSetting.updateOne(
      { key: digestEmailService.DIGEST_SENDING_KEY },
      { $set: { value: { enabled: true } } },
    );
    await expect(digestEmailService.sendDigestEmails([runEntry(digest)]))
      .resolves.toEqual(expect.objectContaining({ disabled: false, sent: 1 }));
  });

  // sprint-review on #2275: the switch is for an incident, and an incident is
  // often a run that is already sending.
  it('a switch flipped mid-run stops the recipients after the flip', async () => {
    const first = await createUser();
    const second = await createUser();
    const digests = [await createDigest(first), await createDigest(second)];
    mockSendEmail.mockImplementationOnce(async () => {
      await SystemSetting.create({ key: digestEmailService.DIGEST_SENDING_KEY, value: { enabled: false } });
      return { data: { data: { succeeded: 1 } } };
    });

    const result = await digestEmailService.sendDigestEmails(digests.map(runEntry));

    expect(result).toEqual(expect.objectContaining({ sent: 1, disabled: true }));
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  // sprint-review on #2277: the per-recipient read sits BEFORE the send, so a
  // flip between the run's first read and the first send stops that email too.
  it('a flip before the first send stops even the first email', async () => {
    const user = await createUser();
    const digest = await createDigest(user);
    const read = jest.spyOn(SystemSetting, 'findOne')
      .mockImplementationOnce(() => ({ lean: async () => null }))
      .mockImplementationOnce(() => ({ lean: async () => ({ value: { enabled: false } }) }));

    await expect(digestEmailService.sendDigestEmails([runEntry(digest)]))
      .resolves.toEqual(expect.objectContaining({ sent: 0, disabled: true }));
    expect(mockSendEmail).not.toHaveBeenCalled();
    read.mockRestore();
  });

  // ...and an unreadable switch mid-run is a read blip, not a flip: the switch
  // was on at the start, and a summary skipped here is never retried.
  it('a read error mid-run does not stop the rest of the run', async () => {
    const digests = [await createDigest(await createUser()), await createDigest(await createUser())];
    const read = jest.spyOn(SystemSetting, 'findOne')
      .mockImplementationOnce(() => ({ lean: async () => null }))
      .mockImplementation(() => { throw new Error('mongo blip'); });

    await expect(digestEmailService.sendDigestEmails(digests.map(runEntry)))
      .resolves.toEqual(expect.objectContaining({ sent: 2, disabled: false }));
    read.mockRestore();
  });

  it('sends nothing when the switch cannot be read', async () => {
    const user = await createUser();
    const digest = await createDigest(user);
    const read = jest.spyOn(SystemSetting, 'findOne').mockImplementation(() => { throw new Error('mongo down'); });

    await expect(digestEmailService.sendDigestEmails([runEntry(digest)]))
      .resolves.toEqual(expect.objectContaining({ disabled: true, sent: 0 }));
    expect(mockSendEmail).not.toHaveBeenCalled();
    read.mockRestore();
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
