/**
 * B1 leak matrix — User read routes. Every user carries password, apiToken,
 * agentRuntimeTokens[].tokenHash, deviceTokens[].tokenHash and
 * digestUnsubscribeToken sentinels.
 *   GET /api/auth/user, /api/auth/profile, /api/auth/api-token, /api/users/profile  (as self)
 *   GET /api/users/:id   (the seeded user, as self / stranger / admin)
 *   GET /api/admin/users (as self / stranger / admin)
 * requireBrowserJwt is satisfied by the auth mock setting authType 'jwt', the
 * value the real JWT branch of middleware/auth.ts sets.
 * The API-token status route is covered here; its raw-token exposure row was
 * removed once the route became metadata-only. Harness and KNOWN_EXPOSURES:
 * __tests__/utils/leakMatrix.js.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) and authController imports it.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);

const { defineLeakMatrix } = require('../../utils/leakMatrix');
const { users } = require('../../utils/leakMatrixSuites');

defineLeakMatrix(users);
