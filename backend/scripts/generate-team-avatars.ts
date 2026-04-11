#!/usr/bin/env ts-node
/**
 * Generate personality-matched OpenAI portraits for the core team agents
 * and save them to their User records.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx ts-node backend/scripts/generate-team-avatars.ts
 *   OPENAI_API_KEY=sk-... npx ts-node backend/scripts/generate-team-avatars.ts --force
 *
 * The script is idempotent: agents whose profilePicture is already set (to a
 * data URI or URL) are skipped unless --force is passed.
 *
 * No agent sessions or runtimes are touched. Only MongoDB User records.
 */

/* eslint-disable no-await-in-loop, no-console */

import 'dotenv/config';
import mongoose from 'mongoose';

// Use require for the identity service to match the rest of the backend.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AgentIdentityService = require('../services/agentIdentityService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  generateImage,
  isOpenAIImageAvailable,
} = require('../services/openaiImageService');

interface AgentProfile {
  agentName: string;
  instanceId: string;
  displayName: string;
  role: string;
  personality: string;
  style: string;
}

const TEAM: AgentProfile[] = [
  {
    agentName: 'liz',
    instanceId: 'liz',
    displayName: 'Liz',
    role: 'autonomous conversationalist',
    personality: 'warm, curious, conversational',
    style: 'soft pastel portrait, friendly expression',
  },
  {
    agentName: 'theo',
    instanceId: 'theo',
    displayName: 'Theo',
    role: 'PR reviewer and architect',
    personality: 'thoughtful, precise, architectural',
    style: 'clean geometric portrait, studious vibe',
  },
  {
    agentName: 'nova',
    instanceId: 'nova',
    displayName: 'Nova',
    role: 'backend systems engineer',
    personality: 'focused, systems-minded, rigorous',
    style: 'cool blue palette, sharp features',
  },
  {
    agentName: 'pixel',
    instanceId: 'pixel',
    displayName: 'Pixel',
    role: 'frontend designer',
    personality: 'playful, visual, creative',
    style: 'vibrant colors, rounded shapes',
  },
  {
    agentName: 'ops',
    instanceId: 'ops',
    displayName: 'Ops',
    role: 'infrastructure and devops',
    personality: 'reliable, calm, no-nonsense',
    style: 'grounded earthy palette, steady gaze',
  },
  {
    agentName: 'x-curator',
    instanceId: 'x-curator',
    displayName: 'X-Curator',
    role: 'content curator for X/Twitter',
    personality: 'social, tasteful, observant',
    style: 'modern editorial portrait',
  },
];

const buildPrompt = (agent: AgentProfile): string => (
  `Stylized portrait avatar for an AI agent named ${agent.displayName}, `
  + `a ${agent.role}. Personality: ${agent.personality}. `
  + `Style: ${agent.style}. Flat illustration, square aspect ratio, simple clean `
  + 'background, friendly, professional, no text.'
);

const looksAlreadySet = (value: unknown): boolean => {
  if (!value || typeof value !== 'string') return false;
  if (value === 'default') return false;
  return value.startsWith('data:image/') || value.startsWith('http');
};

async function run(): Promise<void> {
  const force = process.argv.includes('--force');

  if (!isOpenAIImageAvailable()) {
    console.error('OPENAI_API_KEY is not set. Export it or set it in .env and re-run.');
    process.exitCode = 1;
    return;
  }

  const mongoUri = (process.env.MONGO_URI || 'mongodb://localhost:27017/commonly').trim();
  console.log(`Connecting to Mongo: ${mongoUri.replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  await mongoose.connect(mongoUri);
  console.log('Connected.\n');

  let totalCost = 0;
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const agent of TEAM) {
    const label = `${agent.displayName} (${agent.agentName}/${agent.instanceId})`;
    try {
      // Try the two most common identity shapes: (openclaw, {instanceId}) and
      // (agentName, {instanceId}). Some team agents like theo/nova/pixel/ops/liz
      // are provisioned under the openclaw runtime type with their id as the
      // instanceId; x-curator may be under its own agentType.
      let user = await AgentIdentityService.getOrCreateAgentUser('openclaw', {
        instanceId: agent.instanceId,
      });

      if (!user) {
        user = await AgentIdentityService.getOrCreateAgentUser(agent.agentName, {
          instanceId: agent.instanceId,
        });
      }

      if (!user) {
        console.warn(`  [skip] ${label}: no user record found`);
        skipped += 1;
        continue;
      }

      if (looksAlreadySet(user.profilePicture) && !force) {
        console.log(`  [skip] ${label}: profilePicture already set (use --force to override)`);
        skipped += 1;
        continue;
      }

      const prompt = buildPrompt(agent);
      console.log(`  [gen]  ${label}: requesting image...`);
      const image = await generateImage({
        prompt,
        size: '1024x1024',
      });

      user.profilePicture = image.dataUri;
      user.avatarMetadata = {
        ...(user.avatarMetadata || {}),
        source: 'openai',
        model: image.model,
        prompt,
        generatedAt: new Date(),
      };
      await user.save();

      const cost = image.costEstimateUsd || 0;
      totalCost += cost;
      generated += 1;
      console.log(
        `  [done] ${label}: ${image.model} ~$${cost.toFixed(4)} `
        + `(revisedPrompt: ${image.revisedPrompt ? 'yes' : 'no'})`,
      );
    } catch (error: any) {
      failed += 1;
      const kind = error?.kind ? ` (${error.kind})` : '';
      console.error(`  [fail] ${label}${kind}: ${error?.message || error}`);
    }
  }

  console.log('\nSummary:');
  console.log(`  generated: ${generated}`);
  console.log(`  skipped:   ${skipped}`);
  console.log(`  failed:    ${failed}`);
  console.log(`  estimated total cost: ~$${totalCost.toFixed(4)} USD`);
}

run()
  .catch((err: unknown) => {
    console.error('Unhandled error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    process.exit();
  });
