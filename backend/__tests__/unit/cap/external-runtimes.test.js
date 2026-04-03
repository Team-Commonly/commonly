/**
 * CAP external runtimes unit tests
 *
 * Tests provisionAgentRuntime and getAgentRuntimeStatus (via getDockerRuntimeStatus)
 * for runtimeType: 'webhook' and runtimeType: 'claude-code'.
 *
 * Both are "external" runtimes — the agent manages its own compute.
 * The provisioner must return immediately without touching Docker/K8s.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  provisionAgentRuntime,
  getDockerRuntimeStatus,
  getAgentRuntimeStatus,
} = require('../../../services/agentProvisionerService');

const tempDir = path.join(os.tmpdir(), 'cap-external-runtimes-tests');
const openclawConfigPath = path.join(tempDir, 'moltbot.json');
const commonlyConfigPath = path.join(tempDir, 'commonly-bot.json');

beforeEach(() => {
  fs.mkdirSync(tempDir, { recursive: true });
  if (fs.existsSync(openclawConfigPath)) fs.unlinkSync(openclawConfigPath);
  if (fs.existsSync(commonlyConfigPath)) fs.unlinkSync(commonlyConfigPath);
  process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
  process.env.COMMONLY_BOT_CONFIG_PATH = commonlyConfigPath;
  process.env.OPENCLAW_WORKSPACE_ROOT = path.join(tempDir, 'workspaces');
  // Disable Docker and K8s so no real process calls occur
  process.env.AGENT_PROVISIONER_K8S = '0';
  process.env.AGENT_PROVISIONER_DOCKER = '0';
});

afterAll(() => {
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.COMMONLY_BOT_CONFIG_PATH;
  delete process.env.OPENCLAW_WORKSPACE_ROOT;
  delete process.env.AGENT_PROVISIONER_K8S;
  delete process.env.AGENT_PROVISIONER_DOCKER;
});

// ── provisionAgentRuntime ─────────────────────────────────────────────────────

describe('provisionAgentRuntime — external runtimes', () => {
  test('runtimeType webhook returns { provisioned: true, external: true, runtimeType: "webhook" }', async () => {
    const result = await provisionAgentRuntime({
      runtimeType: 'webhook',
      agentName: 'my-webhook-agent',
      instanceId: 'default',
      runtimeToken: 'cm_agent_webhook_token',
      baseUrl: 'http://backend:5000',
    });

    expect(result).toEqual({
      provisioned: true,
      external: true,
      runtimeType: 'webhook',
    });
  });

  test('runtimeType claude-code returns { provisioned: true, external: true, runtimeType: "claude-code" }', async () => {
    const result = await provisionAgentRuntime({
      runtimeType: 'claude-code',
      agentName: 'claude-code',
      instanceId: 'sess-abc123',
      runtimeToken: 'cm_agent_claude_token',
      baseUrl: 'http://backend:5000',
    });

    expect(result).toEqual({
      provisioned: true,
      external: true,
      runtimeType: 'claude-code',
    });
  });
});

// ── getDockerRuntimeStatus ────────────────────────────────────────────────────

describe('getDockerRuntimeStatus — external runtimes', () => {
  test('runtimeType webhook returns { status: "external", reason: "agent manages its own compute" }', async () => {
    const result = await getDockerRuntimeStatus('webhook');

    expect(result.status).toBe('external');
    expect(result.reason).toMatch(/agent manages its own compute/i);
  });

  test('runtimeType claude-code returns { status: "external", reason: "agent manages its own compute" }', async () => {
    const result = await getDockerRuntimeStatus('claude-code');

    expect(result.status).toBe('external');
    expect(result.reason).toMatch(/agent manages its own compute/i);
  });
});

// ── getAgentRuntimeStatus (unified interface, Docker mode) ────────────────────

describe('getAgentRuntimeStatus — external runtimes (Docker mode, K8s disabled)', () => {
  test('runtimeType webhook resolves to external via unified interface', async () => {
    const result = await getAgentRuntimeStatus('webhook', 'default');

    expect(result.status).toBe('external');
  });

  test('runtimeType claude-code resolves to external via unified interface', async () => {
    const result = await getAgentRuntimeStatus('claude-code', 'sess-abc123');

    expect(result.status).toBe('external');
  });
});
