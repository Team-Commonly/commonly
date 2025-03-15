const mongoose = require('mongoose');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('Pod Model Tests', () => {
  // Setup test user for references
  let testUser;

  // Setup and teardown for MongoDB
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    // Create a test user for each test
    testUser = new User({
      username: 'testuser',
      email: 'test@example.com',
      password: 'Password123!'
    });
    await testUser.save();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('should create a new pod successfully with valid data', async () => {
    const podData = {
      name: 'Test Pod',
      description: 'This is a test pod',
      type: 'chat',
      createdBy: testUser._id
    };

    const pod = new Pod(podData);
    const savedPod = await pod.save();

    expect(savedPod._id).toBeDefined();
    expect(savedPod.name).toBe(podData.name);
    expect(savedPod.description).toBe(podData.description);
    expect(savedPod.type).toBe(podData.type);
    expect(savedPod.createdBy.toString()).toBe(testUser._id.toString());
    expect(savedPod.createdAt).toBeDefined();
    expect(savedPod.updatedAt).toBeDefined();
    
    // Test that creator is automatically added as member
    expect(savedPod.members).toHaveLength(1);
    expect(savedPod.members[0].toString()).toBe(testUser._id.toString());
  });

  it('should not save a pod without required fields', async () => {
    // Test missing name
    const podWithoutName = new Pod({
      description: 'Test pod description',
      type: 'chat',
      createdBy: testUser._id
    });

    // Test missing createdBy
    const podWithoutCreator = new Pod({
      name: 'Test Pod',
      description: 'Test pod description',
      type: 'chat'
    });

    await expect(podWithoutName.save()).rejects.toThrow();
    await expect(podWithoutCreator.save()).rejects.toThrow();
  });

  it('should validate pod type', async () => {
    const podWithInvalidType = new Pod({
      name: 'Test Pod',
      description: 'Test pod description',
      type: 'invalid_type', // Not in enum list
      createdBy: testUser._id
    });

    await expect(podWithInvalidType.save()).rejects.toThrow();
  });

  it('should use default value for pod type if not provided', async () => {
    const pod = new Pod({
      name: 'Test Pod',
      description: 'Test pod description',
      createdBy: testUser._id
      // No type provided, should default to 'chat'
    });

    const savedPod = await pod.save();
    expect(savedPod.type).toBe('chat');
  });

  it('should handle adding members to a pod', async () => {
    // Create additional users
    const secondUser = new User({
      username: 'seconduser',
      email: 'second@example.com',
      password: 'Password123!'
    });
    await secondUser.save();

    const thirdUser = new User({
      username: 'thirduser',
      email: 'third@example.com',
      password: 'Password123!'
    });
    await thirdUser.save();

    // Create pod with testUser as creator
    const pod = new Pod({
      name: 'Members Test Pod',
      description: 'Testing pod members',
      createdBy: testUser._id,
      members: [secondUser._id] // Add secondUser as member initially
    });

    let savedPod = await pod.save();

    // The creator should be automatically added as member even if not in initial members
    expect(savedPod.members).toHaveLength(2);
    expect(savedPod.members.map(id => id.toString())).toContain(testUser._id.toString());
    expect(savedPod.members.map(id => id.toString())).toContain(secondUser._id.toString());

    // Add third user
    savedPod.members.push(thirdUser._id);
    savedPod = await savedPod.save();

    expect(savedPod.members).toHaveLength(3);
    expect(savedPod.members.map(id => id.toString())).toContain(thirdUser._id.toString());
  });

  it('should handle references to messages, announcements, and externalLinks', async () => {
    const mockMessageId = new mongoose.Types.ObjectId();
    const mockAnnouncementId = new mongoose.Types.ObjectId();
    const mockExternalLinkId = new mongoose.Types.ObjectId();

    const pod = new Pod({
      name: 'References Test Pod',
      description: 'Testing pod references',
      createdBy: testUser._id,
      messages: [mockMessageId],
      announcements: [mockAnnouncementId],
      externalLinks: [mockExternalLinkId]
    });

    const savedPod = await pod.save();

    expect(savedPod.messages).toHaveLength(1);
    expect(savedPod.messages[0].toString()).toBe(mockMessageId.toString());
    
    expect(savedPod.announcements).toHaveLength(1);
    expect(savedPod.announcements[0].toString()).toBe(mockAnnouncementId.toString());
    
    expect(savedPod.externalLinks).toHaveLength(1);
    expect(savedPod.externalLinks[0].toString()).toBe(mockExternalLinkId.toString());
  });
}); 