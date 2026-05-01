const request = require('supertest');
const express = require('express');
const fs = require('fs');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user1' };
  req.userId = 'user1';
  next();
});

const Pod = require('../../../models/Pod');
const ExternalLink = require('../../../models/ExternalLink');

jest.mock('../../../models/Pod');
jest.mock('../../../models/ExternalLink');
jest.mock('fs');

const routes = require('../../../routes/pods');

describe('pods routes - external links', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.sendFile = jest.fn(() => res.status(200).end());
      next();
    });
    app.use('/api/pods', routes);
    jest.clearAllMocks();
  });

  it('creates external link with url', async () => {
    const podSave = jest.fn();
    Pod.findById.mockResolvedValue({
      createdBy: { toString: () => 'user1' },
      members: [{ toString: () => 'user1' }],
      externalLinks: [],
      save: podSave,
    });
    const linkSave = jest.fn();
    ExternalLink.mockImplementation((data) => ({
      ...data,
      _id: 'l1',
      save: linkSave,
    }));

    await request(app)
      .post('/api/pods/external-link')
      .send({
        podId: 'p1',
        name: 'Link',
        type: 'discord',
        url: 'http://x',
      })
      .expect(201);

    expect(ExternalLink).toHaveBeenCalledWith(
      expect.objectContaining({
        podId: 'p1',
        name: 'Link',
        type: 'discord',
        createdBy: 'user1',
      }),
    );
    expect(linkSave).toHaveBeenCalled();
    expect(podSave).toHaveBeenCalled();
  });

  it('member (non-owner) can add a link', async () => {
    const podSave = jest.fn();
    Pod.findById.mockResolvedValue({
      createdBy: { toString: () => 'someone-else' },
      members: [{ toString: () => 'user1' }],
      externalLinks: [],
      save: podSave,
    });
    const linkSave = jest.fn();
    ExternalLink.mockImplementation((data) => ({ ...data, _id: 'l2', save: linkSave }));
    await request(app)
      .post('/api/pods/external-link')
      .send({ podId: 'p1', name: 'n', type: 'notion', url: 'https://notion.so/foo' })
      .expect(201);
    expect(linkSave).toHaveBeenCalled();
  });

  it('auto-detects type when client passes type=auto', async () => {
    const podSave = jest.fn();
    Pod.findById.mockResolvedValue({
      createdBy: { toString: () => 'user1' },
      members: [{ toString: () => 'user1' }],
      externalLinks: [],
      save: podSave,
    });
    const linkSave = jest.fn();
    ExternalLink.mockImplementation((data) => ({ ...data, _id: 'l3', save: linkSave }));
    await request(app)
      .post('/api/pods/external-link')
      .send({ podId: 'p1', type: 'auto', url: 'https://docs.google.com/document/d/abc/edit' })
      .expect(201);
    expect(ExternalLink).toHaveBeenCalledWith(
      expect.objectContaining({ podId: 'p1', type: 'google_doc', createdBy: 'user1' }),
    );
  });

  it('detects github PR vs issue vs repo by path', async () => {
    Pod.findById.mockResolvedValue({
      createdBy: { toString: () => 'user1' },
      members: [{ toString: () => 'user1' }],
      externalLinks: [],
      save: jest.fn(),
    });
    const cases = [
      { url: 'https://github.com/Team-Commonly/commonly/pull/261', expected: 'github_pr' },
      { url: 'https://github.com/Team-Commonly/commonly/issues/45', expected: 'github_issue' },
      { url: 'https://github.com/Team-Commonly/commonly', expected: 'github_repo' },
    ];
    /* eslint-disable no-await-in-loop */
    for (const c of cases) {
      ExternalLink.mockImplementation((data) => ({ ...data, _id: 'l', save: jest.fn() }));
      await request(app)
        .post('/api/pods/external-link')
        .send({ podId: 'p1', type: 'auto', url: c.url })
        .expect(201);
      expect(ExternalLink).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: c.expected }),
      );
    }
    /* eslint-enable no-await-in-loop */
  });

  it('returns 400 when required fields missing', async () => {
    await request(app).post('/api/pods/external-link').send({}).expect(400);
  });

  it('returns 404 when pod not found', async () => {
    Pod.findById.mockResolvedValue(null);
    await request(app)
      .post('/api/pods/external-link')
      .send({
        podId: 'p1',
        name: 'n',
        type: 'discord',
        url: 'u',
      })
      .expect(404);
  });

  it('returns 403 when user is neither owner nor member', async () => {
    Pod.findById.mockResolvedValue({
      createdBy: { toString: () => 'other' },
      members: [{ toString: () => 'someone-else' }],
    });
    await request(app)
      .post('/api/pods/external-link')
      .send({
        podId: 'p1',
        name: 'n',
        type: 'discord',
        url: 'u',
      })
      .expect(403);
  });

  it('deletes external link successfully', async () => {
    const podSave = jest.fn();
    ExternalLink.findById.mockResolvedValue({
      podId: 'p1',
      qrCodePath: 'code.png',
    });
    Pod.findById.mockResolvedValue({
      createdBy: { toString: () => 'user1' },
      externalLinks: ['l1'],
      save: podSave,
    });
    fs.existsSync.mockReturnValue(true);

    await request(app).delete('/api/pods/external-link/l1').expect(200);

    expect(ExternalLink.findByIdAndDelete).toHaveBeenCalledWith('l1');
    expect(fs.unlinkSync).toHaveBeenCalledWith('code.png');
    expect(podSave).toHaveBeenCalled();
  });

  it('returns 404 when external link missing on delete', async () => {
    ExternalLink.findById.mockResolvedValue(null);
    await request(app).delete('/api/pods/external-link/l1').expect(404);
  });

  it('returns 403 when deleting link as non-owner', async () => {
    ExternalLink.findById.mockResolvedValue({ podId: 'p1' });
    Pod.findById.mockResolvedValue({ createdBy: { toString: () => 'other' } });
    await request(app).delete('/api/pods/external-link/l1').expect(403);
  });

  it('fetches qrcode when user is member', async () => {
    ExternalLink.findById.mockResolvedValue({
      podId: 'p1',
      type: 'wechat',
      qrCodePath: 'code.png',
    });
    Pod.findById.mockResolvedValue({ members: ['user1'] });

    await request(app).get('/api/pods/external-link/l1/qrcode').expect(200);
  });

  it('returns 404 when qrcode not found', async () => {
    ExternalLink.findById.mockResolvedValue(null);
    await request(app).get('/api/pods/external-link/l1/qrcode').expect(404);
  });

  it('returns 403 when user not member for qrcode', async () => {
    ExternalLink.findById.mockResolvedValue({
      podId: 'p1',
      type: 'wechat',
      qrCodePath: 'code.png',
    });
    Pod.findById.mockResolvedValue({ members: [] });
    await request(app).get('/api/pods/external-link/l1/qrcode').expect(403);
  });

  it('fetches external links list', async () => {
    Pod.findById.mockResolvedValue({ members: ['user1'] });
    ExternalLink.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      populate: jest.fn().mockResolvedValue(['l1']),
    });

    const res = await request(app)
      .get('/api/pods/p1/external-links')
      .expect(200);
    expect(res.body).toEqual(['l1']);
  });

  it('returns 404 when pod missing on external links fetch', async () => {
    Pod.findById.mockResolvedValue(null);
    await request(app).get('/api/pods/p1/external-links').expect(404);
  });
});
