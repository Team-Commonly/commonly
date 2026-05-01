const mongoose = require('mongoose');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const ExternalLink = require('../../../models/ExternalLink');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

describe('ExternalLink Model Tests', () => {
  let user;
  let pod;

  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    user = new User({
      username: 'user',
      email: 'e@example.com',
      password: 'Pass123!',
    });
    await user.save();
    pod = new Pod({
      name: 'Pod',
      description: 'd',
      type: 'chat',
      createdBy: user._id,
    });
    await pod.save();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('requires URL for non-WeChat links', async () => {
    const link = new ExternalLink({
      podId: pod._id,
      name: 'Telegram',
      type: 'telegram',
      createdBy: user._id,
    });
    await expect(link.save()).rejects.toThrow();
  });

  it('allows WeChat link with QR code only', async () => {
    const link = new ExternalLink({
      podId: pod._id,
      name: 'WeChat',
      type: 'wechat',
      qrCodePath: '/path/to/qr.png',
      createdBy: user._id,
    });
    const saved = await link.save();
    expect(saved.type).toBe('wechat');
    expect(saved.qrCodePath).toBe('/path/to/qr.png');
  });

  it.each([
    'notion',
    'google_doc',
    'google_sheet',
    'google_slides',
    'google_drive',
    'figma',
    'zoom',
    'gmail',
    'github_pr',
    'github_issue',
    'github_repo',
    'youtube',
    'loom',
    'other_link',
  ])('accepts artifact type %s with url', async (type) => {
    const link = new ExternalLink({
      podId: pod._id,
      name: `${type} doc`,
      type,
      url: 'https://example.com/x',
      createdBy: user._id,
    });
    const saved = await link.save();
    expect(saved.type).toBe(type);
  });

  it('rejects unknown type', async () => {
    const link = new ExternalLink({
      podId: pod._id,
      name: 'Bogus',
      type: 'not-a-real-type',
      url: 'https://example.com',
      createdBy: user._id,
    });
    await expect(link.save()).rejects.toThrow();
  });
});
