/**
 * B1 leak matrix — GET /api/installables (installableCatalogService's .lean()
 * path, which bypasses the Integration toJSON transform), as the owner of
 * connected telegram / pending slack / github-app connections carrying every
 * sentinel, as a stranger, and as an admin.
 * Skipped routes: none. Harness and KNOWN_EXPOSURES: __tests__/utils/leakMatrix.js.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) and is pulled in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);

const { defineLeakMatrix } = require('../../utils/leakMatrix');
const { installables } = require('../../utils/leakMatrixSuites');

defineLeakMatrix(installables);
