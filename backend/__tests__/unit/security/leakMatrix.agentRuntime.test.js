/**
 * B1 leak matrix — GET /api/agents/runtime/pods/:podId/integrations as an
 * agent with integration:read in the pod, an agent in the pod without that
 * scope, and an agent installed only in another pod. Pod integrations with
 * agent access on/off and a global (globalAgentAccess) integration carry every
 * Integration secret. agentRuntimeAuth is mocked to load the real bot User and
 * its real AgentInstallations (see agentRuntimeAuthMock).
 * Skipped routes: none. Harness and KNOWN_EXPOSURES: __tests__/utils/leakMatrix.js.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) and is pulled in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);

const { defineLeakMatrix } = require('../../utils/leakMatrix');
const { agentRuntime } = require('../../utils/leakMatrixSuites');

defineLeakMatrix(agentRuntime);
