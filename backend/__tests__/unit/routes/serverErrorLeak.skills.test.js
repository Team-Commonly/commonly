// F626: the skill write routes compute their status from the error. A 4xx is a
// refusal we wrote and keeps its message; at 5xx the error is a driver's, so the
// body answers fixed text and the cause goes to the server log.
const request = require('supertest');
const express = require('express');

const DRIVER_TEXT = 'connect ECONNREFUSED db.internal.example:5432 relation "secret_table" does not exist';
const POD_ID = '507f1f77bcf86cd799439011';

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/PodAsset', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../../../models/SkillRating', () => ({}));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { find: jest.fn() } }));
jest.mock('../../../services/podAssetService', () => ({
  upsertImportedSkillAsset: jest.fn(),
  buildScopedSkillKey: jest.fn(() => 'pod:notes'),
}));

const Pod = require('../../../models/Pod');
const PodAsset = require('../../../models/PodAsset');
const PodAssetService = require('../../../services/podAssetService');
const skillsRoutes = require('../../../routes/skills');

const app = express();
app.use(express.json());
app.use('/api/skills', skillsRoutes);

let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: POD_ID, createdBy: 'user-1', members: [] }) });
});
afterEach(() => jest.restoreAllMocks());

const expectFixed = (res, error, label) => {
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error });
  expect(res.text).not.toContain('db.internal.example');
  expect(res.text).not.toContain('secret_table');
  expect(JSON.stringify(errorSpy.mock.calls)).toContain(label);
  expect(JSON.stringify(errorSpy.mock.calls)).toContain('db.internal.example');
};

describe('skill write 500s', () => {
  it('uninstall: a Mongo failure answers fixed text and logs the cause', async () => {
    PodAsset.findOneAndUpdate.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).delete(`/api/skills/pods/${POD_ID}/imported?name=notes`);
    expectFixed(res, 'Failed to uninstall skill', 'Error uninstalling skill:');
  });

  it('uninstall: a 404 we wrote keeps its message', async () => {
    Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const res = await request(app).delete(`/api/skills/pods/${POD_ID}/imported?name=notes`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Pod not found' });
  });

  it('import: a Mongo failure answers fixed text and logs the cause', async () => {
    PodAssetService.upsertImportedSkillAsset.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).post('/api/skills/import')
      .send({ podId: POD_ID, name: 'notes', content: '---\nname: notes\n---\n# Notes' });
    expectFixed(res, 'Failed to import skill', 'Error importing skill:');
  });

  it('import: a 403 we wrote keeps its message', async () => {
    Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: POD_ID, createdBy: 'someone', members: [] }) });
    const res = await request(app).post('/api/skills/import').send({ podId: POD_ID, name: 'notes', content: 'x' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
  });
});
