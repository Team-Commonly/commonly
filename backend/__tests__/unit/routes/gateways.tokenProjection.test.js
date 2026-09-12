const request = require('supertest');
const express = require('express');

// The gateway token is a bearer secret held in the gateway's k8s Secret. It is
// shown once, top-level, in the POST that minted it, and must never be stored
// on the Gateway row or returned from one.

// createdBy is an ObjectId path, so the caller id must cast.
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: '64b000000000000000000001' };
  req.userId = '64b000000000000000000001';
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) if anything pulls it in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));

const mockProvisionGateway = jest.fn();
jest.mock('../../../services/gatewayProvisionerServiceK8s', () => ({
  generateGatewayToken: () => 'gw_minted_once',
  provisionGateway: (...args) => mockProvisionGateway(...args),
  deleteGateway: jest.fn(),
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  getOpenClawConfigPath: () => '',
}));

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const Gateway = require('../../../models/Gateway');
const routes = require('../../../routes/gateways');

const LEGACY_TOKEN = 'gw_legacy_stored_token';
const PATCH_TOKEN = 'gw_patch_supplied_token';

describe('gateway token never leaves through a Gateway row', () => {
  let app;

  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    jest.clearAllMocks();
    mockProvisionGateway.mockResolvedValue({
      namespace: 'ns', service: 'gw-svc', deployment: 'gw-svc', baseUrl: 'http://gw.example.test',
    });
    app = express();
    app.use(express.json());
    app.use('/api/gateways', routes);
  });

  it('GET omits a stored metadata.gatewayToken and keeps the rest of metadata', async () => {
    await Gateway.create({
      name: 'Legacy', slug: 'legacy', mode: 'k8s', metadata: { namespace: 'ns', gatewayToken: LEGACY_TOKEN },
    });

    const res = await request(app).get('/api/gateways');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(LEGACY_TOKEN);
    const legacy = res.body.gateways.find((g) => g.slug === 'legacy');
    expect(legacy.metadata).toEqual({ namespace: 'ns' });
  });

  it('POST k8s returns the minted token once, top-level, and never stores it', async () => {
    const res = await request(app).post('/api/gateways').send({
      name: 'New', mode: 'k8s', metadata: { namespace: 'ns', gatewayToken: 'gw_client_supplied' },
    });

    expect(res.status).toBe(201);
    expect(res.body.gatewayToken).toBe('gw_minted_once');
    expect(res.body.gateway.metadata.gatewayToken).toBeUndefined();
    expect(mockProvisionGateway.mock.calls[0][0].token).toBe('gw_minted_once');
    const stored = await Gateway.findOne({ slug: 'new' }).lean();
    expect(stored.metadata).not.toHaveProperty('gatewayToken');
    expect(stored.metadata.namespace).toBe('ns');
  });

  it('PATCH hands metadata.gatewayToken to the provisioner without storing or returning it', async () => {
    const gw = await Gateway.create({
      name: 'Legacy', slug: 'legacy', mode: 'k8s', metadata: { namespace: 'ns', gatewayToken: LEGACY_TOKEN },
    });

    const res = await request(app).patch(`/api/gateways/${gw._id}`).send({
      metadata: { namespace: 'ns', gatewayToken: PATCH_TOKEN },
    });

    expect(res.status).toBe(200);
    expect(mockProvisionGateway.mock.calls[0][0].token).toBe(PATCH_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(PATCH_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(LEGACY_TOKEN);
    const stored = await Gateway.findById(gw._id).lean();
    expect(stored.metadata).not.toHaveProperty('gatewayToken');
    expect(stored.metadata).toMatchObject({ namespace: 'ns', service: 'gw-svc' });
  });

  it('PATCH on a local gateway strips a supplied token from the row and the response', async () => {
    const gw = await Gateway.create({ name: 'Local', slug: 'local-gw', mode: 'local' });

    const res = await request(app).patch(`/api/gateways/${gw._id}`).send({
      name: 'Local renamed', metadata: { gatewayToken: PATCH_TOKEN, image: 'img' },
    });

    expect(res.status).toBe(200);
    expect(mockProvisionGateway).not.toHaveBeenCalled();
    expect(res.body.gateway.name).toBe('Local renamed');
    expect(res.body.gateway.metadata).toEqual({ image: 'img' });
    const stored = await Gateway.findById(gw._id).lean();
    expect(stored.metadata).toEqual({ image: 'img' });
  });
});
