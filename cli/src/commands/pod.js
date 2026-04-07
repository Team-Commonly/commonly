/**
 * commonly pod <subcommand>
 *
 * list   — list pods you're a member of
 * send   — post a message to a pod
 * tail   — watch a pod's messages live
 */

import { createClient } from '../lib/api.js';
import { getToken, resolveInstanceUrl } from '../lib/config.js';

export const registerPod = (program) => {
  const pod = program.command('pod').description('Manage pods');

  // ── list ──────────────────────────────────────────────────────────────────
  pod
    .command('list')
    .description('List pods you are a member of')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (opts) => {
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: resolveInstanceUrl(opts.instance), token });

      try {
        const data = await client.get('/api/pods');
        const pods = Array.isArray(data) ? data : data.pods || [];

        if (pods.length === 0) { console.log('No pods found.'); return; }

        const col = (s, w) => String(s ?? '').padEnd(w).slice(0, w);
        console.log(`${col('NAME', 24)} ${col('TYPE', 12)} ${col('MEMBERS', 8)} ID`);
        console.log('─'.repeat(70));
        pods.forEach((p) => {
          console.log(`${col(p.name, 24)} ${col(p.type || 'chat', 12)} ${col(p.memberCount ?? p.members?.length ?? '?', 8)} ${p._id}`);
        });
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── send ──────────────────────────────────────────────────────────────────
  pod
    .command('send <podId> <message>')
    .description('Post a message to a pod')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (podId, message, opts) => {
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: resolveInstanceUrl(opts.instance), token });

      try {
        // Try agent runtime endpoint first (agent token), fall back to user endpoint
        const result = await client.post(`/api/agents/runtime/pods/${podId}/messages`, {
          content: message,
        }).catch(() => client.post(`/api/messages/${podId}`, {
          content: message,
        }));

        console.log(`Sent (${result._id || result.id || 'ok'})`);
      } catch (err) {
        console.error(`Failed: ${err.message}`);
        process.exit(1);
      }
    });

  // ── tail ──────────────────────────────────────────────────────────────────
  pod
    .command('tail <podId>')
    .description('Watch pod messages live')
    .option('--filter <type>', 'Filter by sender type: agents, humans, all', 'all')
    .option('--instance <url>', 'Target Commonly instance')
    .action(async (podId, opts) => {
      const token = getToken(opts.instance);
      if (!token) { console.error('Not logged in. Run: commonly login'); process.exit(1); }

      const client = createClient({ instance: resolveInstanceUrl(opts.instance), token });

      let lastId = null;
      console.log(`Watching pod ${podId}... (Ctrl+C to stop)\n`);

      const poll = async () => {
        try {
          const data = await client.get(`/api/messages/${podId}`, {
            limit: 20,
            after: lastId,
          });
          const messages = Array.isArray(data) ? data : data.messages || [];

          messages.forEach((m) => {
            const isBot = m.isBot || m.sender?.isBot;
            if (opts.filter === 'agents' && !isBot) return;
            if (opts.filter === 'humans' && isBot) return;

            const ts = new Date(m.createdAt || m.timestamp).toTimeString().slice(0, 8);
            const who = m.username || m.sender?.username || '?';
            const marker = isBot ? '🤖' : '👤';
            console.log(`[${ts}] ${marker} ${who}: ${m.content}`);
            lastId = m._id || m.id;
          });
        } catch (err) {
          console.error(`[poll error] ${err.message}`);
        }
      };

      await poll();
      const interval = setInterval(poll, 3000);
      process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });
    });
};
