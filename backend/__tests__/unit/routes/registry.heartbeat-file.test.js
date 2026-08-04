const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../services/agentProvisionerService', () => ({
  writeOpenClawHeartbeatFile: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    findOne: jest.fn(),
    find: jest.fn(),
    updateOne: jest.fn(),
  },
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { writeOpenClawHeartbeatFile } = require('../../../services/agentProvisionerService');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('registry heartbeat file updates', () => {
  const arrange = () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });
    AgentInstallation.findOne.mockResolvedValue({
      _id: 'install-1',
      agentName: 'openclaw',
      podId: 'pod-1',
      instanceId: 'default',
      displayName: 'Cuz',
    });
    writeOpenClawHeartbeatFile.mockReturnValue('/tmp/HEARTBEAT.md');
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes heartbeat file for openclaw agents', async () => {
    arrange();

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/openclaw/heartbeat-file')
      .send({ instanceId: 'default', content: '- Check updates' });

    expect(res.status).toBe(200);
    expect(writeOpenClawHeartbeatFile).toHaveBeenCalled();
  });

  // A hand-authored HEARTBEAT.md was invisible to the provisioner: this route
  // wrote the file but never marked the installation customized, so
  // `skipHeartbeat` stayed false and the next reprovision could overwrite the
  // user's template. The flag has to be set where the customization happens.
  it('marks the installation customized so reprovision cannot clobber the edit', async () => {
    arrange();

    await request(app)
      .post('/api/registry/pods/pod-1/agents/openclaw/heartbeat-file')
      .send({ instanceId: 'default', content: '- Check updates' });

    expect(AgentInstallation.updateOne).toHaveBeenCalledWith(
      { _id: 'install-1' },
      { $set: { 'config.customizations.heartbeat': true } },
    );
  });

  it('clears the flag on reset, handing the file back to the provisioner', async () => {
    arrange();

    await request(app)
      .post('/api/registry/pods/pod-1/agents/openclaw/heartbeat-file')
      .send({ instanceId: 'default', content: '- Check updates', reset: true });

    expect(AgentInstallation.updateOne).toHaveBeenCalledWith(
      { _id: 'install-1' },
      { $set: { 'config.customizations.heartbeat': false } },
    );
  });
});

// CodeQL's `js/missing-rate-limiting` anchors to the FIRST middleware in a
// route's chain, and `auth` does a Mongo lookup — so a limiter placed after
// `auth` leaves that lookup unprotected and the route flagged. Alert #1658 sat
// open against the a2a-dms route for three months in exactly that shape, and
// #1720 was created by copying it onto the heartbeat POST. Position 0 is the
// invariant; asserting "a limiter is present somewhere" would stay green
// through the regression it exists to catch.
describe('rate limiters run before auth', () => {
  // express-rate-limit middleware carries `getKey`/`resetKey` as own props
  // (v8.3.2). Identifying it structurally beats matching on a function name,
  // which minification and wrappers both erase.
  const isRateLimiter = (fn) => typeof fn === 'function'
    && typeof fn.getKey === 'function'
    && typeof fn.resetKey === 'function';

  const collectRoutes = (router, out = []) => {
    (router.stack || []).forEach((layer) => {
      if (layer.route) {
        out.push({
          path: layer.route.path,
          methods: layer.route.methods,
          handles: layer.route.stack.map((l) => l.handle),
        });
      } else if (layer.handle && layer.handle.stack) {
        collectRoutes(layer.handle, out);
      }
    });
    return out;
  };

  // Method matters: the heartbeat-file path is registered twice, and the GET
  // has no limiter. Matching on path alone silently resolved to the read route.
  const routeFor = (method, path) => {
    const match = collectRoutes(registryRoutes)
      .find((r) => r.path === path && r.methods[method]);
    expect(match).toBeDefined();
    return match;
  };

  it.each([
    ['post', '/pods/:podId/agents/:name/heartbeat-file'],
    ['get', '/pods/:podId/agents/:name/a2a-dms'],
  ])('%s %s puts its limiter at position 0', (method, path) => {
    const { handles } = routeFor(method, path);
    const at = handles.findIndex(isRateLimiter);

    expect(at).toBe(0);
  });
});
