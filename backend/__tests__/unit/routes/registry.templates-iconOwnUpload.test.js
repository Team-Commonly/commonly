/**
 * An agent template's icon takes only an upload its author can claim (F615).
 *
 * The same rule F609 applies to a direct agent-avatar write: a value that points
 * at a pod-scoped upload someone else made is refused with 400
 * `avatar_not_own_upload`, checked as the CALLER. On install the template's icon
 * becomes the new bot's profilePicture, so the template is the indirect path to
 * the same field.
 */

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { getByName: jest.fn() },
}));
jest.mock('../../../models/AgentTemplate', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  deleteOne: jest.fn(),
}));
jest.mock('../../../models/File', () => ({ findByFileName: jest.fn().mockResolvedValue(null) }));

const { AgentRegistry } = require('../../../models/AgentRegistry');
const AgentTemplate = require('../../../models/AgentTemplate');
const File = require('../../../models/File');
const templatesRouter = require('../../../routes/registry/templates');

const getHandler = (method, path) => {
  const layer = templatesRouter.stack.find((entry) => (
    entry.route && entry.route.path === path && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} handler not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

const REFUSAL = {
  error: 'A profile picture has to be your own upload.',
  code: 'avatar_not_own_upload',
};

const othersPodUpload = () => File.findByFileName.mockImplementation(async (name) => (
  name === 'theirs.png' ? { uploadedBy: 'someone-else', podId: 'pod-1' } : null
));

const createReq = (iconUrl) => ({
  userId: 'user-1',
  body: { agentName: 'openclaw', displayName: 'Aria', ...(iconUrl !== undefined ? { iconUrl } : {}) },
});

const existingTemplate = () => ({
  _id: 'template-1',
  agentName: 'openclaw',
  displayName: 'Aria',
  description: '',
  iconUrl: '/api/uploads/old.png',
  visibility: 'private',
  createdBy: { toString: () => 'user-1' },
  save: jest.fn().mockResolvedValue(undefined),
});

describe('template icon upload references (F615)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    File.findByFileName.mockResolvedValue(null);
    AgentRegistry.getByName.mockResolvedValue({ agentName: 'openclaw' });
    AgentTemplate.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    });
    AgentTemplate.create.mockImplementation(async (data) => ({
      ...data,
      _id: { toString: () => 'template-1' },
    }));
  });

  describe('create', () => {
    it("refuses an icon that is someone else's pod upload, saving nothing", async () => {
      othersPodUpload();
      const res = response();

      await getHandler('post', '/templates')(createReq('/api/uploads/theirs.png'), res);

      expect(File.findByFileName).toHaveBeenCalledWith('theirs.png');
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(REFUSAL);
      expect(AgentTemplate.create).not.toHaveBeenCalled();
    });

    it('refuses the same icon in its absolute-URL form', async () => {
      othersPodUpload();
      const res = response();

      await getHandler('post', '/templates')(createReq('https://api.commonly.me/api/uploads/theirs.png'), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(REFUSAL);
      expect(AgentTemplate.create).not.toHaveBeenCalled();
    });

    it("accepts the caller's own pod upload", async () => {
      File.findByFileName.mockResolvedValue({ uploadedBy: 'user-1', podId: 'pod-1' });
      const res = response();

      await getHandler('post', '/templates')(createReq('/api/uploads/mine.png'), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(AgentTemplate.create).toHaveBeenCalledWith(expect.objectContaining({
        iconUrl: '/api/uploads/mine.png',
      }));
    });

    it('accepts an external https icon without any file lookup', async () => {
      const res = response();

      await getHandler('post', '/templates')(createReq('https://example.com/aria.png'), res);

      expect(res.status).not.toHaveBeenCalled();
      expect(File.findByFileName).not.toHaveBeenCalled();
      expect(AgentTemplate.create).toHaveBeenCalledWith(expect.objectContaining({
        iconUrl: 'https://example.com/aria.png',
      }));
    });

    it('accepts an empty or missing icon', async () => {
      const res1 = response();
      await getHandler('post', '/templates')(createReq(''), res1);
      const res2 = response();
      await getHandler('post', '/templates')(createReq(undefined), res2);

      expect(res1.status).not.toHaveBeenCalled();
      expect(res2.status).not.toHaveBeenCalled();
      expect(AgentTemplate.create).toHaveBeenCalledTimes(2);
      expect(AgentTemplate.create).toHaveBeenCalledWith(expect.objectContaining({ iconUrl: '' }));
    });

    it('refuses an icon carrying more than five upload refs', async () => {
      const res = response();
      const icon = [1, 2, 3, 4, 5, 6].map((n) => `/api/uploads/f${n}.png`).join('#');

      await getHandler('post', '/templates')(createReq(icon), res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(REFUSAL);
      expect(AgentTemplate.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it("refuses an icon that is someone else's pod upload, keeping the old icon", async () => {
      othersPodUpload();
      const template = existingTemplate();
      AgentTemplate.findById.mockResolvedValue(template);
      const res = response();

      await getHandler('patch', '/templates/:id')({
        userId: 'user-1',
        params: { id: 'template-1' },
        body: { iconUrl: '/api/uploads/theirs.png', displayName: 'Renamed' },
      }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(REFUSAL);
      expect(template.iconUrl).toBe('/api/uploads/old.png');
      expect(template.save).not.toHaveBeenCalled();
    });

    it("accepts the caller's own upload, an external URL and a cleared icon", async () => {
      File.findByFileName.mockResolvedValue({ uploadedBy: 'user-1', podId: 'pod-1' });
      for (const [iconUrl, stored] of [
        ['/api/uploads/mine.png', '/api/uploads/mine.png'],
        ['https://example.com/aria.png', 'https://example.com/aria.png'],
        ['', ''],
      ]) {
        const template = existingTemplate();
        AgentTemplate.findById.mockResolvedValue(template);
        const res = response();

        // eslint-disable-next-line no-await-in-loop
        await getHandler('patch', '/templates/:id')({
          userId: 'user-1', params: { id: 'template-1' }, body: { iconUrl },
        }, res);

        expect(res.status).not.toHaveBeenCalled();
        expect(template.iconUrl).toBe(stored);
        expect(template.save).toHaveBeenCalled();
      }
    });

    it('does not look up files when the update leaves the icon alone', async () => {
      const template = existingTemplate();
      AgentTemplate.findById.mockResolvedValue(template);
      const res = response();

      await getHandler('patch', '/templates/:id')({
        userId: 'user-1', params: { id: 'template-1' }, body: { description: 'new' },
      }, res);

      expect(File.findByFileName).not.toHaveBeenCalled();
      expect(template.save).toHaveBeenCalled();
    });
  });
});
