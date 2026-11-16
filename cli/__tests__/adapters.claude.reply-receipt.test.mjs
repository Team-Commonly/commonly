/**
 * F546: a Claude Code seat usually answers through its own
 * commonly_post_message call, not through the wrapper's post, so the reply
 * receipt the wrapper builds never reached it: a Codex reply named its model
 * and effort and a Claude one named nothing. The adapter now hands the spawn's
 * own controls to the Commonly MCP server, which attaches them to its posts.
 */
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

await jest.unstable_mockModule('child_process', () => ({
  spawnSync: jest.fn(),
  spawn: jest.fn(),
}));

const claude = (await import('../src/lib/adapters/claude.js')).default;
const { REPLY_RECEIPT_ENV } = await import('../src/lib/reply-receipt.js');

const fakeChild = () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from('ok'));
    proc.emit('close', 0);
  }, 0);
  return proc;
};

const spawnWith = async (environment) => {
  const configs = [];
  const impl = (cmd, args) => {
    const at = args.indexOf('--mcp-config');
    configs.push(at === -1 ? null : JSON.parse(fs.readFileSync(args[at + 1], 'utf8')));
    return fakeChild();
  };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-claude-receipt-'));
  try {
    await claude.spawn('hi', {
      sessionId: null,
      cwd,
      instanceUrl: 'https://api.example.test',
      runtimeToken: 'cm_agent_secret',
      environment: {
        ...environment,
        mcp: [
          {
            name: 'commonly',
            transport: 'stdio',
            command: ['npx', '-y', '@commonlyai/mcp@latest'],
            env: { COMMONLY_API_URL: '${COMMONLY_API_URL}', COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}' },
          },
          { name: 'local-db', transport: 'stdio', command: ['node', 'db.js'], env: { DB: 'x' } },
        ],
      },
      _spawnImpl: impl,
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return configs[0];
};

describe('claude adapter: the reply receipt reaches the Commonly MCP server (F546)', () => {
  it('names the adapter, model and effort this spawn runs with', async () => {
    const config = await spawnWith({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(JSON.parse(config.mcpServers.commonly.env[REPLY_RECEIPT_ENV]))
      .toEqual({ adapter: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
  });

  it('leaves out a control the spawn did not pass', async () => {
    const config = await spawnWith({ model: 'claude-haiku-5-5' });
    expect(JSON.parse(config.mcpServers.commonly.env[REPLY_RECEIPT_ENV]))
      .toEqual({ adapter: 'claude', model: 'claude-haiku-5-5' });
  });

  // Claude expands ${…} in an MCP entry's env, and a placeholder in the config
  // makes the adapter hand the runtime its credential. A model id is free text,
  // so one carrying `${COMMONLY_AGENT_TOKEN}` must never reach the env.
  it('leaves out a control that holds a ${…} placeholder', async () => {
    const config = await spawnWith({ model: 'x${COMMONLY_AGENT_TOKEN}', effort: 'low' });
    expect(JSON.parse(config.mcpServers.commonly.env[REPLY_RECEIPT_ENV])).toEqual({ adapter: 'claude', effort: 'low' });
    expect(JSON.stringify(config.mcpServers.commonly.env)).not.toContain('${COMMONLY_AGENT_TOKEN}');
  });

  it('gives it to no other MCP server', async () => {
    const config = await spawnWith({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(config.mcpServers['local-db'].env[REPLY_RECEIPT_ENV]).toBeUndefined();
  });
});
