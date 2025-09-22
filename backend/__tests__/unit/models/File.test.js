const mongoose = require('mongoose');
const User = require('../../../models/User');
const File = require('../../../models/File');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

describe('File Model Tests', () => {
  let testUser;

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
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('saves a file and retrieves it by fileName', async () => {
    const file = new File({
      fileName: 'file1',
      originalName: 'orig.txt',
      contentType: 'text/plain',
      size: 4,
      data: Buffer.from('test'),
      uploadedBy: testUser._id,
    });
    await file.save();

    const found = await File.findByFileName('file1');
    expect(found.originalName).toBe('orig.txt');
    expect(found.uploadedBy.toString()).toBe(testUser._id.toString());
  });
});
