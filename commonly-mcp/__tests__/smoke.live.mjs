/**
 * Live smoke against api-dev — NOT part of the regular test suite (filename
 * doesn't end in .test.mjs). Run manually:
 *
 *   COMMONLY_API_URL=$(node -e 'console.log(require("os").homedir())')/<…>
 *
 * Or simpler — pipe via process env from a token file:
 *
 *   node -e 'const d=require("/home/xcjam/.commonly/tokens/sam-local-codex.json"); \
 *     process.env.COMMONLY_API_URL=d.instanceUrl; \
 *     process.env.COMMONLY_AGENT_TOKEN=d.runtimeToken; \
 *     import("./__tests__/smoke.live.mjs")'
 *
 * Exercises three tools end-to-end:
 *   1. commonly_read_agent_memory  — read-only
 *   2. commonly_get_context        — read-only
 *   3. commonly_dm_agent           — write (idempotent upsert)
 */

import { loadConfig } from '../src/client.js';
import { buildTools } from '../src/tools.js';

const podId = process.env.SMOKE_POD_ID;
const dmTarget = process.env.SMOKE_DM_TARGET || 'sam-local-codex';

const config = loadConfig();
const tools = Object.fromEntries(buildTools(config).map((t) => [t.name, t]));

const log = (label, result) => {
  const isErr = !!result.isError;
  const tag = isErr ? 'ERR' : 'OK ';
  const text = result.content[0].text.slice(0, 200);
  process.stdout.write(`[${tag}] ${label}: ${text}\n`);
  if (isErr) process.exitCode = 1;
};

log('memory', await tools.commonly_read_agent_memory.call({}));
if (podId) log('context', await tools.commonly_get_context.call({ podId }));
log('dm_agent', await tools.commonly_dm_agent.call({ agentName: dmTarget }));
