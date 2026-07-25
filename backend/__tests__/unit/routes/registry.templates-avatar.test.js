jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    getByName: jest.fn(),
  },
}));

jest.mock('../../../models/AgentTemplate', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  deleteOne: jest.fn(),
}));

const { AgentRegistry } = require('../../../models/AgentRegistry');
const AgentTemplate = require('../../../models/AgentTemplate');
const templatesRouter = require('../../../routes/registry/templates');

const getHandler = (method, path) => {
  const layer = templatesRouter.stack.find((entry) => (
    entry.route && entry.route.path === path && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} handler not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});

describe('registry template avatar writes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentRegistry.getByName.mockResolvedValue({ agentName: 'openclaw' });
    AgentTemplate.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    });
    AgentTemplate.create.mockImplementation(async (data) => ({
      ...data,
      _id: { toString: () => 'template-1' },
    }));
  });

  it('stores a newly created package icon as a relative upload URL', async () => {
    const req = {
      userId: 'user-1',
      body: {
        agentName: 'openclaw',
        displayName: 'Aria',
        iconUrl: 'https://api-dev.commonly.me/api/uploads/aria.png',
      },
    };
    const res = response();

    await getHandler('post', '/templates')(req, res);

    expect(AgentTemplate.create).toHaveBeenCalledWith(expect.objectContaining({
      iconUrl: '/api/uploads/aria.png',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      template: expect.objectContaining({ iconUrl: '/api/uploads/aria.png' }),
    }));
  });

  it('normalizes an updated package icon without mutating identity data', async () => {
    const template = {
      _id: 'template-1',
      agentName: 'openclaw',
      displayName: 'Aria',
      description: '',
      iconUrl: '/api/uploads/old.png',
      visibility: 'private',
      createdBy: { toString: () => 'user-1' },
      save: jest.fn().mockResolvedValue(undefined),
    };
    AgentTemplate.findById.mockResolvedValue(template);
    const req = {
      userId: 'user-1',
      params: { id: 'template-1' },
      body: { iconUrl: 'http://localhost:5000/api/uploads/new.png' },
    };
    const res = response();

    await getHandler('patch', '/templates/:id')(req, res);

    expect(template.iconUrl).toBe('/api/uploads/new.png');
    expect(template.save).toHaveBeenCalled();
  });
});
