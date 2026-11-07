const express = require('express');
const request = require('supertest');

jest.mock('../../../middleware/auth', () => (req, _res, next) => { req.userId = 'user-1'; next(); });
jest.mock('../../../models/User', () => ({
  findById: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ role: 'user', entitlements: {} }) }) })),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/personaHireService', () => ({ hirePersona: jest.fn() }));

const { hirePersona } = require('../../../services/personaHireService');
const personas = require('../../../routes/personas');

const app = express();
app.use(express.json());
app.use('/api/personas', personas.default || personas);

describe('POST /api/personas/:agentName/hire', () => {
  it('leaves a trace when a person has no hosted seat', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).post('/api/personas/scout/hire').send({ podId: 'pod-1' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('cloud_agents_not_entitled');
    expect(hirePersona).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(
      /^\[install-refused\] .*"code":"cloud_agents_not_entitled".*"agentName":"scout"/,
    ));
  });
});
