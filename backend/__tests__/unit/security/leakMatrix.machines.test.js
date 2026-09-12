/**
 * B1 leak matrix — machine and gateway reads:
 *   GET /api/machines      (owner / stranger / admin: each lists its own)
 *   GET /api/machines/me   (the owner's machine via its REAL cm_daemon_ bearer; human JWTs are 401)
 *   GET /api/gateways      (admin only)
 * Each machine's daemon AgentCredential is real: its raw bearer is a boundary
 * sentinel and its stored tokenHash is registered as a sentinel by value. A
 * gateway row carries metadata.gatewayToken as a sentinel.
 * Skipped routes: none. Harness and KNOWN_EXPOSURES: __tests__/utils/leakMatrix.js.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) if anything pulls it in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);

const { defineLeakMatrix } = require('../../utils/leakMatrix');
const { machines } = require('../../utils/leakMatrixSuites');

defineLeakMatrix(machines);
