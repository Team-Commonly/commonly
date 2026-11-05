const createGroupMeProvider = require('../../../integrations/providers/groupmeProvider');
const Integration = require('../../../models/Integration');

jest.mock('../../../models/Integration');
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/groupmeService', () => ({ sendMessage: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  Integration.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
});

describe('groupmeProvider', () => {
  const integration = { _id: 'int1', config: { botId: 'bot', groupId: '123', maxBufferSize: 2 } };
  const provider = createGroupMeProvider(integration);

  test('validateConfig throws on missing fields', async () => {
    const bad = createGroupMeProvider({ config: {} });
    await expect(bad.validateConfig()).rejects.toThrow(/Missing fields/);
  });

  test('events rejects wrong group', async () => {
    const { events } = provider.getWebhookHandlers();
    const req = { body: { group_id: '999' } };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await events(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('events ignores bot messages and succeeds', async () => {
    Integration.findByIdAndUpdate.mockResolvedValue({});
    const { events } = provider.getWebhookHandlers();
    const req = { body: { group_id: '123', sender_type: 'bot' } };
    const res = { sendStatus: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
    await events(req, res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('ingestEvent normalizes user message', async () => {
    const payload = {
      id: 'm1',
      user_id: 'u1',
      name: 'User',
      text: 'hello',
      created_at: 1700000000,
    };
    const events = await provider.ingestEvent(payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ authorId: 'u1', content: 'hello' });
  });
});

// F143: `!pod` is what a GroupMe binding sends OUT — the pod's latest summary,
// to everyone in the group. A group bound by someone without authority over the
// pod (its creator or an instance admin) gets nothing.
describe('groupmeProvider !pod in a shared group', () => {
  const Pod = require('../../../models/Pod');
  const User = require('../../../models/User');
  const Summary = require('../../../models/Summary');
  const groupmeService = require('../../../services/groupmeService');
  const row = (createdBy) => ({
    _id: 'int1', podId: 'pod-1', createdBy, config: { botId: 'bot', groupId: '123' },
  });
  const ask = async (createdBy) => {
    Integration.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(row(createdBy)) });
    const { events } = createGroupMeProvider(row(createdBy)).getWebhookHandlers();
    const res = { sendStatus: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
    await events({ body: { group_id: '123', text: '!pod' } }, res);
    return res;
  };

  beforeEach(() => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: 'creator-1', members: ['creator-1', 'member-1'] }),
    });
    User.findById.mockImplementation(async (id) => ({ _id: String(id), role: String(id) === 'admin-1' ? 'admin' : 'user' }));
    Summary.findOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ title: 'T', content: 'pod secrets' }) }),
    });
  });

  test('withholds the pod summary from a group a plain member bound', async () => {
    const res = await ask('member-1');
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(Summary.findOne).not.toHaveBeenCalled();
    const text = groupmeService.sendMessage.mock.calls[0][1];
    expect(text).not.toContain('pod secrets');
    expect(text).toMatch(/only the pod's creator/i);
  });

  test('reads the summary from the pod it checked, the stored row', async () => {
    // The live row was moved to pod-2 after this provider was built for pod-1.
    const stale = { ...row('creator-1'), podId: 'pod-1' };
    const live = { ...row('creator-1'), podId: 'pod-2' };
    Integration.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue(live) });
    const { events } = createGroupMeProvider(stale).getWebhookHandlers();
    const res = { sendStatus: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
    await events({ body: { group_id: '123', text: '!pod' } }, res);
    expect(Pod.findById).toHaveBeenCalledWith('pod-2');
    expect(Summary.findOne).toHaveBeenCalledWith(expect.objectContaining({ podId: 'pod-2' }));
  });

  test.each([['the pod creator', 'creator-1'], ['an instance admin', 'admin-1']])(
    'sends the pod summary to a group %s bound',
    async (_label, createdBy) => {
      await ask(createdBy);
      expect(groupmeService.sendMessage.mock.calls[0][1]).toContain('pod secrets');
    },
  );
});

