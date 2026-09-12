/**
 * B1 leak matrix — GET /api/agent-profile/:agentName/:instanceId? (public
 * identity card, no auth; selects the bot User's agentConfig). Run as a
 * stranger and as an unauthenticated caller. The agent User carries every User
 * secret plus agentConfig.systemPrompt as sentinels; its AgentInstallation
 * carries runtime secrets and a runtime-token hash.
 * Skipped routes: /avatar/can-edit (authed owner check, not a public read).
 * Harness and KNOWN_EXPOSURES: __tests__/utils/leakMatrix.js.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) if anything pulls it in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);

const { defineLeakMatrix } = require('../../utils/leakMatrix');
const { agentProfile } = require('../../utils/leakMatrixSuites');

defineLeakMatrix(agentProfile);
