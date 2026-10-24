const mongoose = require('mongoose');
const request = require('supertest');
const express = require('express');

const mockSendEmail = jest.fn().mockResolvedValue({});
jest.mock('../../services/emailService', () => ({ sendEmail: mockSendEmail }));
jest.mock('jsonwebtoken', () => ({}));

const User = require('../../models/User');
const NeedsYouEmail = require('../../models/NeedsYouEmail');
const NeedsYouEmailQuota = require('../../models/NeedsYouEmailQuota');
const { sendNeedsYouEmail } = require('../../services/needsYouEmailService');
const emailRoutes = require('../../routes/email');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

const app = express();
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
app.use('/api/email', emailRoutes);

let sequence = 0;
const human = async (extra = {}) => {
  sequence += 1;
  return User.create({
    username: `needs-email-${sequence}`,
    email: `person-${sequence}@mail.example.org`,
    password: 'Password123!', verified: true,
    lastActive: new Date(Date.now() - 11 * 60 * 1000),
    ...extra,
  });
};
const item = (user, title) => ({
  _id: new mongoose.Types.ObjectId(), recipientUserId: user._id,
  title, detail: '<review this> & decide', podName: 'Research', actorName: 'Scout',
});

describe('needs-you email', () => {
  const originalEnv = process.env;
  beforeAll(setupMongoDb);
  afterAll(async () => { process.env = originalEnv; await closeMongoDb(); });
  beforeEach(async () => {
    await clearMongoDb();
    mockSendEmail.mockClear();
    process.env = {
      ...originalEnv,
      SMTP2GO_API_KEY: 'test-key', SMTP2GO_FROM_EMAIL: 'team@commonly.me',
      FRONTEND_URL: 'https://commonly.me', BACKEND_URL: 'https://api.commonly.me',
    };
  });

  it('sends once per item, caps at three per person per UTC day, and records a write-once click', async () => {
    const user = await human();
    const rows = Array.from({ length: 4 }, (_, index) => item(user, `Ask ${index}`));
    await Promise.all(rows.map(sendNeedsYouEmail));
    await sendNeedsYouEmail(rows[0]);

    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    const claims = await NeedsYouEmail.find({ recipientUserId: user._id });
    expect(claims).toHaveLength(4);
    expect(claims.filter((row) => row.status === 'overflow')).toHaveLength(1);
    expect((await NeedsYouEmailQuota.findOne({ recipientUserId: user._id })).count).toBe(3);
    const unsubscribeToken = (await User.findById(user._id).select('+digestUnsubscribeToken')).digestUnsubscribeToken;
    expect(mockSendEmail.mock.calls.every(([mail]) => mail.textBody.includes(`/unsubscribe/needs-you/${unsubscribeToken}`))).toBe(true);
    const delivered = await NeedsYouEmail.findOne({ recipientUserId: user._id, status: 'sent' }).select('+clickToken');
    const response = await request(app).get(`/api/email/needs-you/open/${delivered.clickToken}`);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`https://commonly.me/v2/activity?item=${delivered.attentionItemId}`);
    const firstClick = (await NeedsYouEmail.findById(delivered._id)).clickedAt;
    await request(app).get(`/api/email/needs-you/open/${delivered.clickToken}`);
    expect((await NeedsYouEmail.findById(delivered._id)).clickedAt.getTime()).toBe(firstClick.getTime());
    const deliveredBody = JSON.stringify(mockSendEmail.mock.calls[0][0]);
    expect(deliveredBody).not.toContain('review this');
    expect(deliveredBody).not.toContain('Research');
    expect(deliveredBody).not.toContain('Scout');
    expect(deliveredBody).not.toContain('Ask 0');
  });

  it('skips an active, unverified, opted-out, bot, or reserved-domain recipient', async () => {
    const users = await Promise.all([
      human({ lastActive: new Date() }),
      human({ verified: false }),
      human({ emailPreferences: { needsYou: false } }),
      human({ isBot: true }),
      human({ email: 'qa@example.test' }),
    ]);
    await Promise.all(users.map((user, index) => sendNeedsYouEmail(item(user, `Ask ${index}`))));
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(await NeedsYouEmail.countDocuments()).toBe(0);
  });

  it('uses the existing unsubscribe token to opt out of only needs-you email', async () => {
    const user = await human();
    await sendNeedsYouEmail(item(user, 'First ask'));
    const fresh = await User.findById(user._id).select('+digestUnsubscribeToken');
    const response = await request(app).get(`/api/email/unsubscribe/needs-you/${fresh.digestUnsubscribeToken}`);
    expect(response.status).toBe(200);
    expect(response.text).toContain('Needs-you emails are off');
    const after = await User.findById(user._id);
    expect(after.emailPreferences.needsYou).toBe(false);
    expect(after.emailPreferences.dailyDigest).toBe(true);
    await sendNeedsYouEmail(item(user, 'Second ask'));
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
});
