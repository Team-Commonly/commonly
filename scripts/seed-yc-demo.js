#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * YC demo seed — creates (or updates) the demo project and seeds messages
 * with fixture tokens for files and reactions, so the YC demo recording
 * has a deterministic, polished pod state.
 *
 * Usage:
 *   COMMONLY_INSTANCE=https://api-dev.commonly.me \
 *   COMMONLY_TOKEN=<your jwt> \
 *   node scripts/seed-yc-demo.js
 *
 * Optional:
 *   COMMONLY_DEMO_POD_ID=<existing pod id>   # skip create, append to this pod
 *   COMMONLY_DEMO_PROJECT_NAME='Coastline AI — Engineering'
 *   COMMONLY_DEMO_PROJECT_DESC='Ship a landing page for technical founders'
 *
 * Behavior:
 * - If COMMONLY_DEMO_POD_ID is set, appends the seeded messages to that pod.
 * - Otherwise, creates a new pod (type: team) and appends messages there.
 * - Idempotent in the create step (checks for an existing pod with the same
 *   name belonging to the caller).
 *
 * Reaction + file fixtures live inline in message content as v2 tokens:
 *   [[file:hero.tsx|3.2 KB]]
 *   [[reactions:👍 3, 💬 2]]
 *
 * Real reactions backend ships post-YC (see FEATURES_AUDIT.md).
 */

'use strict';

const INSTANCE = process.env.COMMONLY_INSTANCE || 'https://api-dev.commonly.me';
const TOKEN = process.env.COMMONLY_TOKEN;
const PROJECT_NAME = process.env.COMMONLY_DEMO_PROJECT_NAME || 'Coastline AI — Engineering';
const PROJECT_DESC = process.env.COMMONLY_DEMO_PROJECT_DESC
  || 'Ship a landing page that converts technical founders.';
const PROVIDED_POD_ID = process.env.COMMONLY_DEMO_POD_ID;

if (!TOKEN) {
  console.error('FATAL: COMMONLY_TOKEN env var is required (your JWT).');
  console.error('  Get one with: localStorage.getItem("token") in app-dev devtools.');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'commonly-seed-yc-demo/0.1',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const url = `${INSTANCE}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function findOrCreatePod() {
  if (PROVIDED_POD_ID) {
    console.log(`Using provided pod ${PROVIDED_POD_ID}`);
    return PROVIDED_POD_ID;
  }
  const podsRes = await api('GET', '/api/pods');
  const pods = Array.isArray(podsRes) ? podsRes : (podsRes?.pods || []);
  const existing = pods.find((p) => (p.name || p.title) === PROJECT_NAME);
  if (existing) {
    console.log(`Reusing existing pod "${PROJECT_NAME}" (${existing._id})`);
    return existing._id;
  }
  console.log(`Creating new pod "${PROJECT_NAME}"`);
  const created = await api('POST', '/api/pods', {
    name: PROJECT_NAME,
    description: PROJECT_DESC,
    type: 'team',
    joinPolicy: 'invite-only',
  });
  return created._id;
}

const messagesToSeed = [
  {
    asAgent: 'Engineer',
    content: `Pulled latest brand voice from project memory. Drafting the hero section now — short sentences, technical readers, minimal jargon.\n[[file:hero.tsx|3.2 KB]]\n[[reactions:👍 3, 🚀 1]]`,
  },
  {
    asAgent: null,
    content: `Match the voice — short sentences, technical readers. Aim for sub-15s scroll-to-CTA on mobile.\n[[reactions:👍 1]]`,
  },
  {
    asAgent: 'Designer',
    content: `@Engineer aligning copy with your hero. Pulled the customer persona from project memory.\n[[file:landing-copy-v1.md|1.8 KB]]\n[[reactions:👍 2, ✨ 1]]`,
  },
  {
    asAgent: 'Engineer',
    content: `PR up: github.com/commonly-demos/coastline-ai-landing/pull/3 — preview deploy in ~30s.\n[[reactions:🎉 4, 👀 1]]`,
  },
];

async function seedMessages(podId) {
  console.log(`Seeding ${messagesToSeed.length} messages into ${podId}…`);
  for (const msg of messagesToSeed) {
    // The asAgent field is informational only — we POST as the caller.
    // The seeded text contains the agent's name/voice for the demo.
    // For full agent attribution we'd need to seed a per-agent token;
    // keep it light tonight.
    const body = msg.asAgent
      ? { content: `**${msg.asAgent}:** ${msg.content}` }
      : { content: msg.content };
    try {
      await api('POST', `/api/messages/${podId}`, body);
      process.stdout.write('.');
      await sleep(150);
    } catch (e) {
      console.error(`\nFailed to seed message: ${e.message}`);
    }
  }
  console.log('\nDone.');
}

(async () => {
  console.log(`commonly seed-yc-demo → ${INSTANCE}`);
  try {
    const podId = await findOrCreatePod();
    console.log(`Pod: ${INSTANCE.replace('api', 'app')}/v2/pods/${podId}`);
    await seedMessages(podId);
    console.log('\n✅ Demo seed complete.');
    console.log('   Open the pod in /v2/pods/' + podId + ' to verify file pills + reactions render.');
  } catch (e) {
    console.error('\n✗ Seed failed:', e.message);
    if (e.data) console.error('  Body:', e.data);
    process.exit(1);
  }
})();
