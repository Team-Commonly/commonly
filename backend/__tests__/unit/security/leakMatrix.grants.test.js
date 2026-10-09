/**
 * B1 leak matrix — RoomGrant read routes. Grants carry connectionId, brokerId
 * and a raw audience (with a departed member) as sentinels; the connection
 * Integration carries every Integration secret.
 *   GET /api/grants/:grantId          [pod grant | seat grant]
 *   GET /api/grants/:grantId/calls    [pod grant | seat grant]
 *   GET /api/pods/:podId/grants       (mounted via grants.podGrantsRouter)
 * Roles: owner (granter), member, stranger, admin, and the seat agent on the
 * two dualAuth routes. ToolCall (Postgres) is mocked at its module boundary.
 * Skipped routes: none. Harness and KNOWN_EXPOSURES: __tests__/utils/leakMatrix.js.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) if anything pulls it in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);

const { defineLeakMatrix } = require('../../utils/leakMatrix');
const { grants } = require('../../utils/leakMatrixSuites');

defineLeakMatrix(grants);
