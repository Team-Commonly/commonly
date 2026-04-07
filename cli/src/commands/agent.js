/**
 * commonly agent <subcommand>
 *
 * register   — register a webhook agent against an instance
 * connect    — local dev loop: poll events → forward to localhost
 * list       — list installed agents
 * logs       — stream recent events for an agent
 * heartbeat  — manually trigger an agent's heartbeat
 */

import { createClient } from '../lib/api.js';
import { getToken, resolveInstanceUrl } from '../lib/config.js';
import { startPoller } from '../lib/poller.js';
import { startWebhookServer, forwardToLocalWebhook } from '../lib/webhook-server.js';

export const registerAgent = (program) => {
  const agent = program.command('agent').description('Manage agents');

  // ── register ──────────────────────────────────────────────────────────────
  agent
    .command('register')
    .description('Register a webhook agent')
    .requiredOption('--name <name>', 'Agent name (e.g. my-agent)')
    .requiredOption('--pod <podId>', 'Pod ID to install into')
    .requiredOption('--webhook <url>', 'Webhook URL (e.g. https://my-agent.example.com/cap)')
    .option('--secret <secret>', 'Webhook signing secret (HMAC-SHA256)')
    .option('--display <name>', 'Display name shown in the pod')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (opts) => {
      const instanceUrl = resolveInstanceUrl(opts.instance);
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: instanceUrl, token });

      try {
        // Publish the agent definition if it doesn't exist yet
        await client.post('/api/registry/publish', {
          manifest: {
            name: opts.name,
            version: '1.0.0',
            description: opts.display || opts.name,
            runtimeType: 'webhook',
          },
          displayName: opts.display || opts.name,
        }).catch(() => {
          // Ignore publish errors — agent may already exist, install will proceed
        });

        const result = await client.post('/api/registry/install', {
          agentName: opts.name,
          podId: opts.pod,
          displayName: opts.display || opts.name,
          version: '1.0.0',
          config: {
            runtime: {
              runtimeType: 'webhook',
              webhookUrl: opts.webhook,
              ...(opts.secret ? { webhookSecret: opts.secret } : {}),
            },
          },
          scopes: ['context:read', 'messages:write', 'memory:read'],
        });

        const installation = result.installation || result;
        const instId = installation.instanceId || 'default';
        console.log(`Agent registered: ${installation.agentName} (${instId})`);
        console.log(`Pod: ${opts.pod}`);
        console.log(`Webhook: ${opts.webhook}`);

        // Fetch runtime token for agent connect
        let runtimeToken = result.runtimeToken;
        if (!runtimeToken) {
          try {
            const tokenData = await client.post(
              `/api/registry/pods/${opts.pod}/agents/${opts.name}/runtime-tokens`, {},
            );
            runtimeToken = tokenData.token;
          } catch {
            // non-fatal — user can fetch manually
          }
        }
        if (runtimeToken) {
          console.log(`\nRuntime token: ${runtimeToken}`);
          console.log('Use this with: commonly agent connect --name <name> --token <token>');
        }
      } catch (err) {
        console.error(`Registration failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── connect ───────────────────────────────────────────────────────────────
  agent
    .command('connect')
    .description('Start local dev loop — poll events and forward to localhost')
    .requiredOption('--name <name>', 'Agent name')
    .option('--port <port>', 'Local webhook server port', '3001')
    .option('--path <path>', 'Local webhook path', '/cap')
    .option('--secret <secret>', 'Signing secret to verify forwarded events')
    .option('--token <token>', 'Agent runtime token (cm_agent_*) — use instead of user token for event polling')
    .option('--instance-id <id>', 'Instance ID (default: "default")', 'default')
    .option('--instance <url>', 'Target Commonly instance')
    .option('--interval <ms>', 'Poll interval in ms', '5000')
    .action(async (opts) => {
      const instanceUrl = resolveInstanceUrl(opts.instance);
      const token = opts.token || getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const port = parseInt(opts.port, 10);
      const localUrl = `http://localhost:${port}${opts.path}`;

      console.log(`Connecting ${opts.name} → ${instanceUrl}`);
      console.log(`Forwarding events to ${localUrl}`);
      console.log('Waiting for events... (Ctrl+C to stop)\n');

      // Start local webhook server
      const { close } = await startWebhookServer({
        port,
        path: opts.path,
        secret: opts.secret,
        onEvent: async (event) => {
          // Developer's agent code handles this — just ack locally
          console.log(`[local] ${event.type} from pod ${event.podId}`);
          return { outcome: 'acknowledged' };
        },
        onReady: (url) => console.log(`Local server ready: ${url}`),
      });

      // Start poller — forwards each event to the local server
      const poller = startPoller({
        instanceUrl,
        token,
        agentName: opts.name,
        instanceId: opts.instanceId,
        intervalMs: parseInt(opts.interval, 10),
        onEvent: async (event) => {
          const ts = new Date().toTimeString().slice(0, 8);
          process.stdout.write(`[${ts}] ${event.type.padEnd(18)}`);

          try {
            const result = await forwardToLocalWebhook(event, localUrl, opts.secret);
            console.log(`→ ${result.outcome}`);
            return result;
          } catch (err) {
            console.log(`→ error (${err.message})`);
            return { outcome: 'error', reason: err.message };
          }
        },
        onError: (err) => {
          console.error(`[poll error] ${err.message}`);
        },
      });

      // Graceful shutdown
      process.on('SIGINT', () => {
        console.log('\nStopping...');
        poller.stop();
        close();
        process.exit(0);
      });
    });

  // ── list ──────────────────────────────────────────────────────────────────
  agent
    .command('list')
    .description('List installed agents')
    .option('--pod <podId>', 'Filter by pod')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (opts) => {
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: resolveInstanceUrl(opts.instance), token });

      try {
        const params = opts.pod ? { podId: opts.pod } : {};
        const data = await client.get('/api/registry/admin/installations', params);
        const installations = data.installations || data || [];

        if (installations.length === 0) {
          console.log('No agents installed.');
          return;
        }

        const col = (s, w) => String(s ?? '').padEnd(w).slice(0, w);
        console.log(`${col('NAME', 16)} ${col('INSTANCE', 10)} ${col('RUNTIME', 10)} ${col('STATUS', 10)} LAST SEEN`);
        console.log('─'.repeat(70));
        installations.forEach((inst) => {
          const runtimeType = inst.config?.runtime?.runtimeType || inst.runtimeType || '?';
          const lastSeen = inst.usage?.lastUsedAt
            ? new Date(inst.usage.lastUsedAt).toLocaleString()
            : 'never';
          console.log(`${col(inst.agentName, 16)} ${col(inst.instanceId, 10)} ${col(runtimeType, 10)} ${col(inst.status, 10)} ${lastSeen}`);
        });
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── logs ──────────────────────────────────────────────────────────────────
  agent
    .command('logs <name>')
    .description('Stream recent events for an agent')
    .option('--instance-id <id>', 'Instance ID', 'default')
    .option('--follow', 'Keep polling for new events', false)
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (name, opts) => {
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: resolveInstanceUrl(opts.instance), token });

      const fetchAndPrint = async () => {
        const { events = [] } = await client.get('/api/agents/runtime/events', {
          agentName: name,
          instanceId: opts.instanceId,
          limit: 20,
        });
        events.forEach((e) => {
          const ts = new Date(e.createdAt).toTimeString().slice(0, 8);
          const outcome = e.delivery?.outcome || e.status;
          console.log(`[${ts}] ${e.type.padEnd(18)} → ${outcome}`);
        });
        return events;
      };

      try {
        await fetchAndPrint();
        if (opts.follow) {
          console.log('Following... (Ctrl+C to stop)');
          setInterval(fetchAndPrint, 5000);
        }
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── heartbeat ─────────────────────────────────────────────────────────────
  agent
    .command('heartbeat <name>')
    .description('Manually trigger an agent heartbeat')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (name, opts) => {
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: resolveInstanceUrl(opts.instance), token });

      try {
        await client.post(`/api/registry/admin/agents/${name}/trigger-heartbeat`, {});
        console.log(`Heartbeat triggered for ${name}`);
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }
    });
};
