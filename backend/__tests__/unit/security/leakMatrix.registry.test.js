/**
 * B1 leak matrix — agent registry reads, each as owner (pod creator) / member /
 * stranger / admin (not a member):
 *   GET /api/registry/pods/:podId/agents/:name                 (persisted installation config)
 *   GET /api/registry/pods/:podId/agents/:name/runtime-tokens  (selects agentRuntimeTokens)
 *   GET /api/registry/pods/:podId/agents/:name/user-token      (selects +apiToken)
 * The agent User carries apiToken / agentRuntimeTokens[].tokenHash sentinels;
 * the AgentInstallation carries runtimeTokens[].tokenHash and a config with
 * runtime.webhookSecret, authProfiles[].key and skillEnv values as sentinels.
 * The full /api/registry router is mounted, as server.ts does.
 * Skipped routes: none of the three. Harness and KNOWN_EXPOSURES: __tests__/utils/leakMatrix.js.
 */
jest.mock('../../../middleware/auth', () => require('../../utils/leakMatrix').authMock);
jest.mock('../../../middleware/agentRuntimeAuth', () => require('../../utils/leakMatrix').agentRuntimeAuthMock);
// Auth is mocked, so no JWT is ever verified; jsonwebtoken fails to load on
// Node 26 (buffer-equal-constant-time) if anything pulls it in transitively.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../models/ToolCall', () => require('../../utils/leakMatrix').toolCallMock);

const { defineLeakMatrix } = require('../../utils/leakMatrix');
const { registry } = require('../../utils/leakMatrixSuites');

defineLeakMatrix(registry);
