const mongoose = require('mongoose');
const ObjectId = mongoose.Types.ObjectId;
const AgentManifest = require('../../../models/AgentManifest');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

describe('AgentManifest Model Tests', () => {
  const testOwnerId = new ObjectId();

  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('should create a new agent manifest with valid data', async () => {
    const manifestData = {
      name: 'Test Agent',
      slug: 'test-agent',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      owner: testOwnerId,
    };

    const manifest = new AgentManifest(manifestData);
    const savedManifest = await manifest.save();

    expect(savedManifest._id).toBeDefined();
    expect(savedManifest.name).toBe(manifestData.name);
    expect(savedManifest.slug).toBe(manifestData.slug);
    expect(savedManifest.version).toBe(manifestData.version);
    expect(savedManifest.author).toBe(manifestData.author);
    expect(savedManifest.runtimeType).toBe(manifestData.runtimeType);
    expect(savedManifest.isPublic).toBe(false);
    expect(savedManifest.createdAt).toBeDefined();
  });

  it('should not save manifest without required fields', async () => {
    const manifestWithoutName = new AgentManifest({
      slug: 'test-agent',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      owner: testOwnerId,
    });

    const manifestWithoutSlug = new AgentManifest({
      name: 'Test Agent',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      owner: testOwnerId,
    });

    const manifestWithoutVersion = new AgentManifest({
      name: 'Test Agent',
      slug: 'test-agent',
      author: 'Test Author',
      runtimeType: 'webhook',
      owner: testOwnerId,
    });

    const manifestWithoutAuthor = new AgentManifest({
      name: 'Test Agent',
      slug: 'test-agent',
      version: '1.0.0',
      runtimeType: 'webhook',
      owner: testOwnerId,
    });

    const manifestWithoutRuntimeType = new AgentManifest({
      name: 'Test Agent',
      slug: 'test-agent',
      version: '1.0.0',
      author: 'Test Author',
      owner: testOwnerId,
    });

    await expect(manifestWithoutName.save()).rejects.toThrow();
    await expect(manifestWithoutSlug.save()).rejects.toThrow();
    await expect(manifestWithoutVersion.save()).rejects.toThrow();
    await expect(manifestWithoutAuthor.save()).rejects.toThrow();
    await expect(manifestWithoutRuntimeType.save()).rejects.toThrow();
  });

  it('should not allow duplicate slugs', async () => {
    const manifestData = {
      name: 'Test Agent',
      slug: 'duplicate-test',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      owner: testOwnerId,
    };

    const firstManifest = new AgentManifest(manifestData);
    await firstManifest.save();

    const secondManifest = new AgentManifest({ ...manifestData, _id: new ObjectId() });
    await expect(secondManifest.save()).rejects.toThrow();
  });

  it('should enforce runtimeType enum values', async () => {
    const validRuntimeTypes = ['webhook', 'moltbot', 'internal'];
    const invalidRuntimeType = 'invalid';

    for (const runtimeType of validRuntimeTypes) {
      const manifest = new AgentManifest({
        name: 'Test Agent',
        slug: `test-${runtimeType}`,
        version: '1.0.0',
        author: 'Test Author',
        runtimeType,
        owner: testOwnerId,
      });
      const saved = await manifest.save();
      expect(saved.runtimeType).toBe(runtimeType);
    }

    const invalidManifest = new AgentManifest({
      name: 'Test Agent',
      slug: 'test-invalid',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: invalidRuntimeType,
      owner: testOwnerId,
    });
    await expect(invalidManifest.save()).rejects.toThrow();
  });

  it('should store capabilities as array', async () => {
    const capabilities = ['chat', 'memory', 'web-search'];
    const manifest = new AgentManifest({
      name: 'Test Agent',
      slug: 'test-capabilities',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      capabilities,
      owner: testOwnerId,
    });

    const savedManifest = await manifest.save();
    expect(savedManifest.capabilities).toEqual(capabilities);
  });

  it('should default isPublic to false', async () => {
    const manifest = new AgentManifest({
      name: 'Test Agent',
      slug: 'test-default-public',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      owner: testOwnerId,
    });

    const savedManifest = await manifest.save();
    expect(savedManifest.isPublic).toBe(false);
  });

  it('should allow setting isPublic to true', async () => {
    const manifest = new AgentManifest({
      name: 'Test Agent',
      slug: 'test-public',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      isPublic: true,
      owner: testOwnerId,
    });

    const savedManifest = await manifest.save();
    expect(savedManifest.isPublic).toBe(true);
  });

  it('should normalize slug to lowercase', async () => {
    const manifest = new AgentManifest({
      name: 'Test Agent',
      slug: 'UPPER-CASE-SLUG',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      owner: testOwnerId,
    });

    const savedManifest = await manifest.save();
    expect(savedManifest.slug).toBe('upper-case-slug');
  });

  it('should store optional fields correctly', async () => {
    const manifestData = {
      name: 'Test Agent',
      slug: 'test-optional',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      description: 'A test agent description',
      webhookUrl: 'https://example.com/webhook',
      iconUrl: 'https://example.com/icon.png',
      owner: testOwnerId,
    };

    const manifest = new AgentManifest(manifestData);
    const savedManifest = await manifest.save();

    expect(savedManifest.description).toBe(manifestData.description);
    expect(savedManifest.webhookUrl).toBe(manifestData.webhookUrl);
    expect(savedManifest.iconUrl).toBe(manifestData.iconUrl);
  });

  it('should store owner and installedBy references', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const installedById = new mongoose.Types.ObjectId();

    const manifest = new AgentManifest({
      name: 'Test Agent',
      slug: 'test-references',
      version: '1.0.0',
      author: 'Test Author',
      runtimeType: 'webhook',
      owner: ownerId,
      installedBy: installedById,
    });

    const savedManifest = await manifest.save();
    expect(savedManifest.owner.toString()).toBe(ownerId.toString());
    expect(savedManifest.installedBy.toString()).toBe(installedById.toString());
  });
});
