// eslint-disable-next-line no-unused-vars
const mongoose = require('mongoose');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const Message = require('../../../models/Message');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('Message Model Tests', () => {
  // Setup test user and pod for references
  let testUser;
  let testPod;

  // Setup and teardown for MongoDB
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    // Create a test user and pod for each test
    testUser = new User({
      username: 'testuser',
      email: 'test@example.com',
      password: 'Password123!',
    });
    await testUser.save();

    testPod = new Pod({
      name: 'Test Pod',
      description: 'Test pod description',
      type: 'chat',
      createdBy: testUser._id,
    });
    await testPod.save();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('should create a new message successfully with valid data', async () => {
    const messageData = {
      podId: testPod._id,
      userId: testUser._id,
      content: 'This is a test message',
      messageType: 'text',
    };

    const message = new Message(messageData);
    const savedMessage = await message.save();

    expect(savedMessage._id).toBeDefined();
    expect(savedMessage.podId.toString()).toBe(testPod._id.toString());
    expect(savedMessage.userId.toString()).toBe(testUser._id.toString());
    expect(savedMessage.content).toBe(messageData.content);
    expect(savedMessage.messageType).toBe(messageData.messageType);
    expect(savedMessage.createdAt).toBeDefined();
    expect(savedMessage.updatedAt).toBeDefined();
  });

  it('should not save a message without required fields', async () => {
    // Test missing podId
    const messageWithoutPodId = new Message({
      userId: testUser._id,
      content: 'Test message content',
    });

    // Test missing userId
    const messageWithoutUserId = new Message({
      podId: testPod._id,
      content: 'Test message content',
    });

    // Test missing content
    const messageWithoutContent = new Message({
      podId: testPod._id,
      userId: testUser._id,
    });

    await expect(messageWithoutPodId.save()).rejects.toThrow();
    await expect(messageWithoutUserId.save()).rejects.toThrow();
    await expect(messageWithoutContent.save()).rejects.toThrow();
  });

  it('should validate message type', async () => {
    const messageWithInvalidType = new Message({
      podId: testPod._id,
      userId: testUser._id,
      content: 'Test message content',
      messageType: 'invalid_type', // Not in enum list
    });

    await expect(messageWithInvalidType.save()).rejects.toThrow();
  });

  it('should use default value for message type if not provided', async () => {
    const message = new Message({
      podId: testPod._id,
      userId: testUser._id,
      content: 'Test message content',
      // No messageType provided, should default to 'text'
    });

    const savedMessage = await message.save();
    expect(savedMessage.messageType).toBe('text');
  });

  it('should handle references to Pod and User correctly', async () => {
    const message = new Message({
      podId: testPod._id,
      userId: testUser._id,
      content: 'Test message content',
    });

    await message.save();

    // Test that we can populate the references
    const populatedMessage = await Message.findById(message._id)
      .populate('podId')
      .populate('userId')
      .exec();

    expect(populatedMessage.podId).toBeDefined();
    expect(populatedMessage.podId.name).toBe(testPod.name);

    expect(populatedMessage.userId).toBeDefined();
    expect(populatedMessage.userId.username).toBe(testUser.username);
  });
});
