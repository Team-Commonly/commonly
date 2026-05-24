import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

import {
  upsertEnvFileValues,
  patchClawdbotConfig,
  bootstrapClawdbotRuntime,
} from '../src/commands/dev.js';

describe('dev command helpers', () => {
  test('upsertEnvFileValues updates existing keys and appends missing ones', () => {
    const current = [
      '# local dev',
      'COMMONLY_LOCAL_CLAWDBOT=0',
      'JWT_SECRET=test-secret',
      '',
    ].join('\n');

    const next = upsertEnvFileValues(current, {
      COMMONLY_LOCAL_CLAWDBOT: '1',
      OPENCLAW_RUNTIME_TOKEN: 'cm_agent_test',
    });

    expect(next).toContain('COMMONLY_LOCAL_CLAWDBOT=1');
    expect(next).toContain('JWT_SECRET=test-secret');
    expect(next).toContain('OPENCLAW_RUNTIME_TOKEN=cm_agent_test');
    expect(next.startsWith('# local dev')).toBe(true);
    expect(next.endsWith('\n')).toBe(true);
  });

  test('patchClawdbotConfig syncs gateway, account, and binding state', () => {
    const patched = patchClawdbotConfig({
      config: {
        channels: {
          commonly: {
            enabled: true,
            baseUrl: 'http://backend:5000',
            accounts: {},
          },
        },
        agents: { list: [] },
        bindings: [],
      },
      accountId: 'local',
      podId: 'pod-1',
      displayName: 'Local OpenClaw',
      runtimeToken: 'cm_agent_test',
      userToken: 'cm_user_test',
      gatewayToken: 'gateway-test',
    });

    expect(patched.gateway.auth.token).toBe('gateway-test');
    expect(patched.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback).toBe(true);
    expect(patched.channels.commonly.accounts.local.runtimeToken).toBe('cm_agent_test');
    expect(patched.channels.commonly.accounts.local.userToken).toBe('cm_user_test');
    expect(patched.channels.commonly.accounts.local.podIds).toEqual(['pod-1']);
    expect(patched.bindings).toContainEqual({
      agentId: 'local',
      match: { channel: 'commonly', accountId: 'local' },
    });
    expect(patched.agents.list).toContainEqual(expect.objectContaining({
      id: 'local',
      name: 'Local OpenClaw',
    }));
  });

  test('bootstrapClawdbotRuntime writes env and config using the runtime-token routes', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commonly-dev-test-'));
    const envExamplePath = path.join(repoRoot, '.env.example');
    const envPath = path.join(repoRoot, '.env');
    const configPath = path.join(repoRoot, 'external', 'clawdbot-state', 'config', 'moltbot.json');

    fs.writeFileSync(envExamplePath, 'COMMONLY_LOCAL_CLAWDBOT=0\nCLAWDBOT_GATEWAY_TOKEN=\n', 'utf8');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({
      channels: {
        commonly: {
          enabled: true,
          baseUrl: 'http://backend:5000',
          accounts: {},
        },
      },
      agents: { list: [] },
      bindings: [],
    }, null, 2)}\n`, 'utf8');

    const client = {
      get: jest.fn(async (route) => {
        if (route === '/api/pods') return [];
        if (route === '/api/registry/pods/pod-1/agents') return { agents: [] };
        throw new Error(`unexpected GET ${route}`);
      }),
      post: jest.fn(async (route, body) => {
        if (route === '/api/pods') {
          return { _id: 'pod-1', name: body.name };
        }
        if (route === '/api/registry/install') {
          return {
            installation: {
              agentName: 'openclaw',
              instanceId: 'local',
              podId: body.podId,
              displayName: body.displayName,
            },
          };
        }
        if (route === '/api/registry/pods/pod-1/agents/openclaw/provision') {
          return { configPath: '/app/external/clawdbot-state/config/moltbot.json' };
        }
        if (route === '/api/registry/pods/pod-1/agents/openclaw/runtime-tokens') {
          expect(body).toEqual({ instanceId: 'local', force: true });
          return { token: 'cm_agent_fresh' };
        }
        if (route === '/api/registry/pods/pod-1/agents/openclaw/user-token') {
          return { token: 'cm_user_fresh' };
        }
        throw new Error(`unexpected POST ${route}`);
      }),
    };

    const result = await bootstrapClawdbotRuntime({
      client,
      repoRoot,
      instanceId: 'local',
      displayName: 'Local OpenClaw',
      gatewayToken: 'gateway-fresh',
    });

    expect(result.podId).toBe('pod-1');
    expect(result.podCreated).toBe(true);
    expect(result.installationCreated).toBe(true);
    expect(result.runtimeToken).toBe('cm_agent_fresh');
    expect(result.userToken).toBe('cm_user_fresh');

    const envContents = fs.readFileSync(envPath, 'utf8');
    expect(envContents).toContain('COMMONLY_LOCAL_CLAWDBOT=1');
    expect(envContents).toContain('CLAWDBOT_GATEWAY_TOKEN=gateway-fresh');
    expect(envContents).toContain('OPENCLAW_RUNTIME_TOKEN=cm_agent_fresh');
    expect(envContents).toContain('OPENCLAW_USER_TOKEN=cm_user_fresh');

    const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(parsedConfig.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback).toBe(true);
    expect(parsedConfig.channels.commonly.accounts.local.runtimeToken).toBe('cm_agent_fresh');
    expect(parsedConfig.channels.commonly.accounts.local.userToken).toBe('cm_user_fresh');
  });
});
