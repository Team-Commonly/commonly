const request = require('supertest');
const express = require('express');

jest.mock('../../../models/User', () => ({
  findOneAndUpdate: jest.fn(),
}));

const User = require('../../../models/User');
const emailRoutes = require('../../../routes/email');

const app = express();
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
app.use('/api/email', emailRoutes);

describe('GET /api/email/unsubscribe/:token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('turns daily digest email off for a valid token and returns confirmation HTML', async () => {
    const token = 'a'.repeat(48);
    User.findOneAndUpdate.mockResolvedValue({ _id: 'user-1' });

    const response = await request(app)
      .get(`/api/email/unsubscribe/${token}`)
      .set('CF-Connecting-IP', '203.0.113.10');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('Daily digests are off');
    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      { digestUnsubscribeToken: token },
      { $set: { 'emailPreferences.dailyDigest': false } },
      { new: true },
    );
  });

  it('returns 404 for an invalid token without querying MongoDB', async () => {
    const response = await request(app)
      .get('/api/email/unsubscribe/not-a-token')
      .set('CF-Connecting-IP', '203.0.113.11');

    expect(response.status).toBe(404);
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rate-limits repeated anonymous unsubscribe lookups', async () => {
    User.findOneAndUpdate.mockResolvedValue(null);
    const token = 'b'.repeat(48);
    const responses = await Promise.all(Array.from({ length: 31 }, () => (
      request(app)
        .get(`/api/email/unsubscribe/${token}`)
        .set('CF-Connecting-IP', '203.0.113.12')
    )));
    const rateLimited = responses.filter((response) => response.status === 429);

    expect(rateLimited).toHaveLength(1);
    expect(rateLimited[0].body).toEqual(expect.objectContaining({ code: 'rate_limited' }));
    expect(User.findOneAndUpdate).toHaveBeenCalledTimes(30);
  });
});
