// /api/health lists which outside services are configured. Email goes through
// SMTP2GO (authController.hasEmailDeliveryConfig), so that is the email row the
// health check reports; the SendGrid row read a variable nothing else reads.

const request = require('supertest');
const express = require('express');

jest.mock('../../../config/db-pg', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }), on: jest.fn() },
  connectPG: jest.fn(),
}));

const healthRoutes = require('../../../routes/health');

const buildApp = () => {
  const app = express();
  app.use('/api/health', healthRoutes);
  return app;
};

// AGENT_PROVISIONER_K8S is cleared too: with it set, the route would try a real Redis.
const EMAIL_ENV = ['SMTP2GO_API_KEY', 'SMTP2GO_FROM_EMAIL', 'SENDGRID_API_KEY', 'AGENT_PROVISIONER_K8S'];

describe('GET /api/health services', () => {
  const saved = {};
  beforeEach(() => {
    EMAIL_ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  });
  afterEach(() => {
    EMAIL_ENV.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
  });

  it('reports SMTP2GO as configured when its key and sender are set', async () => {
    process.env.SMTP2GO_API_KEY = 'test-key';
    process.env.SMTP2GO_FROM_EMAIL = 'noreply@example.test';
    const res = await request(buildApp()).get('/api/health');
    expect(res.body.checks.services.smtp2go).toEqual({ configured: true });
  });

  it('reports SMTP2GO as not configured without a sender, whatever SendGrid holds', async () => {
    process.env.SMTP2GO_API_KEY = 'test-key';
    process.env.SENDGRID_API_KEY = 'unused';
    const res = await request(buildApp()).get('/api/health');
    expect(res.body.checks.services.smtp2go).toEqual({ configured: false });
  });

  it('no longer reports a SendGrid row', async () => {
    process.env.SENDGRID_API_KEY = 'unused';
    const res = await request(buildApp()).get('/api/health');
    expect(res.body.checks.services).not.toHaveProperty('sendgrid');
  });
});
