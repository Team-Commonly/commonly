jest.mock('../../../models/Integration', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

jest.mock('../../../models/Post', () => {
  const Post = jest.fn(function Post(doc) {
    Object.assign(this, doc);
  });
  Post.find = jest.fn();
  Post.insertMany = jest.fn();
  return Post;
});

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
  },
}));

jest.mock('../../../integrations', () => ({
  get: jest.fn(),
}));

jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

const Integration = require('../../../models/Integration');
const Post = require('../../../models/Post');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const registry = require('../../../integrations');
const AgentEventService = require('../../../services/agentEventService');
const externalFeedService = require('../../../services/externalFeedService');

describe('externalFeedService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EXTERNAL_FEED_PERSIST_POSTS;
  });

  const mockFindChain = (value) => ({
    select: () => ({
      lean: jest.fn().mockResolvedValue(value),
    }),
    lean: jest.fn().mockResolvedValue(value),
  });

  test('does not persist external feed posts by default and enqueues curator events', async () => {
    Integration.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          _id: 'int-1',
          type: 'x',
          podId: 'pod-1',
          status: 'connected',
          isActive: true,
          createdBy: 'user-1',
          config: { messageBuffer: [], maxBufferSize: 1000 },
        },
      ]),
    });
    Post.find.mockImplementation(() => mockFindChain([]));
    AgentInstallation.find.mockReturnValue(mockFindChain([
      {
        agentName: 'openclaw',
        instanceId: 'x-curator',
        displayName: 'X Curator',
        status: 'active',
        config: { autonomy: { enabled: true } },
      },
    ]));
    registry.get.mockReturnValue({
      syncRecent: jest.fn().mockResolvedValue({
        messages: [
          {
            externalId: 'x-1',
            content: 'post one',
            timestamp: new Date().toISOString(),
            authorName: 'author',
            metadata: { url: 'https://x.com/post/1' },
            attachments: [],
          },
        ],
        content: 'Synced external feed',
      }),
    });

    const results = await externalFeedService.syncExternalFeeds();

    expect(Post.insertMany).not.toHaveBeenCalled();
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'openclaw',
        instanceId: 'x-curator',
        podId: 'pod-1',
        type: 'curate',
        payload: expect.objectContaining({
          source: 'external-feed-sync',
          provider: 'x',
          messageCount: 1,
        }),
      }),
    );
    expect(results[0]).toEqual(expect.objectContaining({
      createdPosts: 0,
      curatorEventsEnqueued: 1,
    }));
  });

  test('can persist external posts when EXTERNAL_FEED_PERSIST_POSTS=1', async () => {
    process.env.EXTERNAL_FEED_PERSIST_POSTS = '1';
    Integration.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          _id: 'int-2',
          type: 'x',
          podId: 'pod-1',
          status: 'connected',
          isActive: true,
          createdBy: 'user-1',
          config: { messageBuffer: [], maxBufferSize: 1000 },
        },
      ]),
    });
    Post.find.mockImplementation(() => mockFindChain([]));
    Post.insertMany.mockResolvedValue([]);
    AgentInstallation.find.mockReturnValue(mockFindChain([]));
    registry.get.mockReturnValue({
      syncRecent: jest.fn().mockResolvedValue({
        messages: [
          {
            externalId: 'x-2',
            content: 'post two',
            timestamp: new Date().toISOString(),
            authorName: 'author',
            metadata: { url: 'https://x.com/post/2' },
            attachments: [],
          },
        ],
      }),
    });

    const results = await externalFeedService.syncExternalFeeds();

    expect(Post.insertMany).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(expect.objectContaining({
      createdPosts: 1,
      curatorEventsEnqueued: 0,
    }));
  });
});
