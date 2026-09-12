/**
 * B1 leak matrix — Integration read routes, each as stranger / member / owner / admin:
 *   GET /api/integrations/catalog
 *   GET /api/integrations/:podId          (config.connectCode allowed to member/owner/admin here only)
 *   GET /api/integrations/admin/all
 *   GET /api/integrations/user/all
 *   GET /api/integrations/:id/ingest-tokens
 *   GET /api/discord/binding/:podId
 *   GET /api/admin/integrations/global
 * Skipped routes: none. Integration, DiscordIntegration, Pod, User run on
 * memory Mongo so the real toJSON transforms and populates are exercised.
 * Harness, sentinels and KNOWN_EXPOSURES: __tests__/utils/leakMatrix.js.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) and is pulled in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);

const { defineLeakMatrix } = require('../../utils/leakMatrix');
const { integrations } = require('../../utils/leakMatrixSuites');

defineLeakMatrix(integrations);
