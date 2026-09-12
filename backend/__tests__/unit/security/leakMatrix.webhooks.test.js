/**
 * B1 leak matrix — GET /api/webhooks/discord/channels/:integrationId
 * (routes/webhooks/discord.ts). The router carries no auth middleware, so it is
 * run as the integration's owner, a stranger, and an unauthenticated caller
 * (no header at all). A stranger or anonymous 2xx is an access exposure (the
 * correct answer is 401/403); the Integration and its DiscordIntegration carry
 * every secret as a sentinel.
 * DiscordService is REAL; only axios (the network boundary) is stubbed.
 * Skipped routes: POST / and POST /test/:integrationId (not reads).
 * Harness and KNOWN_EXPOSURES: __tests__/utils/leakMatrix.js.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) if anything pulls it in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);
jest.mock('axios', () => require('../../utils/leakMatrix').axiosMock);

const { defineLeakMatrix } = require('../../utils/leakMatrix');
const { webhooks } = require('../../utils/leakMatrixSuites');

defineLeakMatrix(webhooks);
