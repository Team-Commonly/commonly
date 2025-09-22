const mongoose = require('mongoose');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const Announcement = require('../../../models/Announcement');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

describe('Announcement Model Tests', () => {
  let testUser;
  let testPod;

  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    testUser = new User({
      username: 'testuser',
      email: 'test@example.com',
      password: 'Password123!',
    });
    await testUser.save();
    testPod = new Pod({
      name: 'Test Pod',
      description: 'desc',
      type: 'chat',
      createdBy: testUser._id,
    });
    await testPod.save();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('creates an announcement with required fields', async () => {
    const announcement = new Announcement({
      podId: testPod._id,
      createdBy: testUser._id,
      title: 'Title',
      content: 'Content',
    });
    const saved = await announcement.save();
    expect(saved._id).toBeDefined();
    expect(saved.title).toBe('Title');
    expect(saved.content).toBe('Content');
    expect(saved.podId.toString()).toBe(testPod._id.toString());
    expect(saved.createdBy.toString()).toBe(testUser._id.toString());
  });

  it('fails validation when content is missing', async () => {
    const announcement = new Announcement({
      podId: testPod._id,
      createdBy: testUser._id,
      title: 'Title',
    });
    await expect(announcement.save()).rejects.toThrow();
  });
});
