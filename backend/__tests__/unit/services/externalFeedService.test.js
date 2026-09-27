jest.mock('../../../models/Integration', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
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

const mongoose = require('mongoose');
const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const Post = require('../../../models/Post');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const registry = require('../../../integrations');
const AgentEventService = require('../../../services/agentEventService');
const externalFeedService = require('../../../services/externalFeedService');

describe('externalFeedService', () => {
  // The real shape: the service reads the pod with `.lean()`, so members and a
  // lean integration's `createdBy` are ObjectIds, not strings. String members
  // would let a raw `members.includes(owner)` pass for the shared predicate
  // (TASK-164 ledger M10 - the fixture, not the code, decides that).
  const OWNER_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
  const OTHER_ID = new mongoose.Types.ObjectId('507f191e810c19729de860ea');

  const mockFindChain = (value) => ({
    select: () => ({
      lean: jest.fn().mockResolvedValue(value),
    }),
    lean: jest.fn().mockResolvedValue(value),
  });

  const mockPodMembers = (members) => {
    // A fresh instance carrying the same hex, which is what a lean read of the
    // pod produces: the pod's ObjectId and the integration's are never the same
    // reference. Admitting the owner has to be a value comparison, so a raw
    // `members.includes(owner)` - reference equality - is refused here
    // (TASK-164 ledger M10).
    const stored = members.map((member) => (
      member instanceof mongoose.Types.ObjectId
        ? new mongoose.Types.ObjectId(member.toHexString())
        : member
    ));
    Pod.findById.mockReturnValue({
      select: () => ({ lean: jest.fn().mockResolvedValue({ _id: 'pod-1', members: stored }) }),
    });
  };

  const feedRow = (over = {}) => ({
    _id: 'int-1',
    type: 'x',
    podId: 'pod-1',
    status: 'connected',
    isActive: true,
    createdBy: OWNER_ID,
    config: { messageBuffer: [], maxBufferSize: 1000 },
    ...over,
  });

  const mockOneFeed = (over = {}) => {
    Integration.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([feedRow(over)]) });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.EXTERNAL_FEED_PERSIST_POSTS;
    // The default fixture is a pod that lists the integration's owner, so every
    // pre-existing arm below stays a listed-owner arm (TASK-164).
    mockPodMembers([OWNER_ID]);
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
          createdBy: OWNER_ID,
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
    // The agreed control for the membership arms below (wren, TASK-164): a
    // listed owner still reaches the provider, still buffers, still enqueues.
    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith('int-1', {
      $push: {
        'config.messageBuffer': expect.objectContaining({ $each: expect.any(Array) }),
      },
    });
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
          createdBy: OWNER_ID,
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

  test('persists refreshed OAuth tokens even when no new external posts are returned', async () => {
    Integration.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          _id: 'int-3',
          type: 'x',
          podId: 'pod-1',
          status: 'connected',
          isActive: true,
          createdBy: OWNER_ID,
          config: { messageBuffer: [], maxBufferSize: 1000 },
        },
      ]),
    });
    registry.get.mockReturnValue({
      syncRecent: jest.fn().mockResolvedValue({
        messages: [],
        content: 'No new posts',
        meta: {
          tokenRefreshed: true,
          refreshedAccessToken: 'new-access-token',
          refreshedRefreshToken: 'new-refresh-token',
          refreshedTokenType: 'bearer',
          refreshedScope: 'tweet.read users.read offline.access',
          refreshedExpiresIn: 7200,
        },
      }),
    });

    const results = await externalFeedService.syncExternalFeeds();

    expect(results[0]).toEqual(expect.objectContaining({
      success: true,
      messageCount: 0,
      content: 'No new posts',
    }));
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
      'int-3',
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'connected',
          errorMessage: null,
          'config.accessToken': 'new-access-token',
          'config.refreshToken': 'new-refresh-token',
          'config.tokenType': 'bearer',
          'config.oauthScopes': ['tweet.read', 'users.read', 'offline.access'],
        }),
      }),
    );
  });

  test('marks integration as error when sync fails', async () => {
    Integration.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          _id: 'int-4',
          type: 'x',
          podId: 'pod-1',
          status: 'connected',
          isActive: true,
          createdBy: OWNER_ID,
          config: { messageBuffer: [], maxBufferSize: 1000 },
        },
      ]),
    });
    registry.get.mockReturnValue({
      syncRecent: jest.fn().mockRejectedValue(new Error('invalid_request')),
    });

    const results = await externalFeedService.syncExternalFeeds();

    expect(results[0]).toEqual(expect.objectContaining({
      integrationId: 'int-4',
      success: false,
    }));
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
      'int-4',
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'error',
          errorMessage: 'invalid_request',
          // Named, not omitted (wren 73858): a `$set` that leaves a key out
          // inherits the row's stored value, so silence here would keep a stale
          // `true` from an earlier human-authored reason and print this
          // provider text in the user's connector list.
          errorMessageUserFacing: false,
        }),
      }),
    );
  });

  describe('owner membership (TASK-164)', () => {
    test('a departed owner calls no provider, buffers nothing, and pauses the row with the reason', async () => {
      mockPodMembers([OTHER_ID]);
      mockOneFeed();

      const results = await externalFeedService.syncExternalFeeds();

      // No provider call, so no cursor advance either: the whole sync is skipped.
      expect(registry.get).not.toHaveBeenCalled();
      expect(Post.insertMany).not.toHaveBeenCalled();
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();

      const writes = Integration.findByIdAndUpdate.mock.calls;
      expect(writes).toHaveLength(1);
      const [, update] = writes[0];
      expect(writes[0][0]).toBe('int-1');
      expect(update.$push).toBeUndefined();
      expect(update.$set).toEqual(expect.objectContaining({
        status: 'error',
        errorMessageUserFacing: true,
      }));
      expect(update.$set.errorMessage).toContain('no longer a member of the pod');
      // isActive stays true, so the row stays on the owner's Connectors page;
      // the pause is expressed as status, and nothing here writes the flag.
      expect(update.$set.isActive).toBeUndefined();
      expect(results[0]).toEqual(expect.objectContaining({
        integrationId: 'int-1',
        success: false,
        paused: true,
        messageCount: 0,
      }));
    });

    test('a departed owner writes no posts on the flag-on path either', async () => {
      process.env.EXTERNAL_FEED_PERSIST_POSTS = '1';
      mockPodMembers([]);
      mockOneFeed();

      const results = await externalFeedService.syncExternalFeeds();

      expect(Post.find).not.toHaveBeenCalled();
      expect(Post.insertMany).not.toHaveBeenCalled();
      expect(registry.get).not.toHaveBeenCalled();
      expect(results[0]).toEqual(expect.objectContaining({ paused: true, success: false }));
    });

    test('a pod that is gone pauses rather than syncing into nothing', async () => {
      Pod.findById.mockReturnValue({ select: () => ({ lean: jest.fn().mockResolvedValue(null) }) });
      mockOneFeed();

      const results = await externalFeedService.syncExternalFeeds();

      expect(registry.get).not.toHaveBeenCalled();
      expect(results[0]).toEqual(expect.objectContaining({ paused: true, success: false }));
    });

    test('a listed owner is unaffected: provider, buffer and curator events all run', async () => {
      mockPodMembers([OWNER_ID]);
      mockOneFeed();
      registry.get.mockReturnValue({
        syncRecent: jest.fn().mockResolvedValue({
          messages: [{
            externalId: 'x-9',
            content: 'post nine',
            timestamp: new Date().toISOString(),
            authorName: 'author',
          }],
          content: 'Synced external feed',
        }),
      });
      Post.find.mockImplementation(() => mockFindChain([]));
      AgentInstallation.find.mockReturnValue(mockFindChain([]));

      const results = await externalFeedService.syncExternalFeeds();

      expect(registry.get).toHaveBeenCalledWith('x', expect.objectContaining({ _id: 'int-1' }));
      expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith('int-1', expect.objectContaining({
        $push: expect.anything(),
      }));
      expect(results[0]).toEqual(expect.objectContaining({ success: true, messageCount: 1 }));
      expect(results[0].paused).toBeUndefined();
    });
  });
});
