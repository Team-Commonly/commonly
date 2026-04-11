#!/usr/bin/env ts-node
/**
 * Generate personality-matched AI portraits for the core team agents and
 * save them to their User records.
 *
 * Goes through AgentAvatarService.generateAvatarDetailed() which respects
 * the AVATAR_PROVIDER env var (default 'auto' = Gemini → OpenAI → SVG).
 * So this will use Gemini 2.5 Flash Image when GEMINI_API_KEY is available,
 * or OpenAI/LiteLLM when OPENAI_API_KEY is set.
 *
 * Usage (inside backend pod with env already set):
 *   npx ts-node scripts/generate-team-avatars.ts
 *   npx ts-node scripts/generate-team-avatars.ts --force
 *
 * Or locally:
 *   GEMINI_API_KEY=AIza... MONGO_URI=... npx ts-node backend/scripts/generate-team-avatars.ts
 *   OPENAI_API_KEY=sk-...  MONGO_URI=... npx ts-node backend/scripts/generate-team-avatars.ts
 *
 * The script is idempotent: agents whose profilePicture is already set (to a
 * data URI or URL) are skipped unless --force is passed.
 *
 * No agent sessions or runtimes are touched. Only MongoDB User records.
 */

/* eslint-disable no-await-in-loop, no-console */

import 'dotenv/config';
import mongoose from 'mongoose';

// Use require to match the rest of the backend's module idiom.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AgentIdentityService = require('../services/agentIdentityService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AgentAvatarService = require('../services/agentAvatarService');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isOpenAIImageAvailable } = require('../services/openaiImageService');

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

const looksAlreadySet = (value: unknown): boolean => {
  if (!value || typeof value !== 'string') return false;
  if (value === 'default') return false;
  return value.startsWith('data:image/') || value.startsWith('http');
};

async function run(): Promise<void> {
  const force = process.argv.includes('--force');

  const hasGemini = Boolean((process.env.GEMINI_API_KEY || '').trim());
  const hasOpenai = isOpenAIImageAvailable();
  if (!hasGemini && !hasOpenai) {
    console.error(
      'No image provider configured. Set GEMINI_API_KEY (preferred) or '
      + 'OPENAI_API_KEY / LITELLM_BASE_URL+LITELLM_MASTER_KEY and re-run.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Providers available — gemini: ${hasGemini}, openai: ${hasOpenai}. `
    + `Active: ${process.env.AVATAR_PROVIDER || 'auto'}`,
  );

  const mongoUri = (process.env.MONGO_URI || 'mongodb://localhost:27017/commonly').trim();
  console.log(`Connecting to Mongo: ${mongoUri.replace(/\/\/[^@]+@/, '//<redacted>@')}`);
  await mongoose.connect(mongoUri);
  console.log('Connected.\n');

  let generated = 0;
  let skipped = 0;
  let failed = 0;
  const sources: Record<string, number> = {};

  for (const agent of TEAM) {
    const label = `${agent.displayName} (${agent.agentName}/${agent.instanceId})`;
    try {
      // Try the two most common identity shapes: (openclaw, {instanceId}) and
      // (agentName, {instanceId}). Team agents like theo/nova/pixel/ops/liz
      // are provisioned under the openclaw runtime type; x-curator may be
      // under its own agentType.
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

      console.log(`  [gen]  ${label}: requesting image via AgentAvatarService...`);
      // Go through the full priority chain (Gemini → OpenAI → SVG → letter).
      // Style/personality/colorScheme feed the avatar prompt builder inside
      // the service; customPrompt adds agent-specific flavor.
      const customPrompt = (
        `Portrait of ${agent.displayName}, a ${agent.role}. `
        + `Personality: ${agent.personality}. Visual style: ${agent.style}. `
        + 'Flat illustration, square aspect ratio, simple clean background, '
        + 'friendly, professional expression, no text.'
      );
      const result = await AgentAvatarService.generateAvatarDetailed({
        agentName: agent.displayName,
        style: 'illustration',
        personality: agent.personality.split(',')[0]?.trim() || 'friendly',
        colorScheme: 'vibrant',
        gender: 'neutral',
        customPrompt,
      });

      if (!result?.avatar) {
        failed += 1;
        console.error(`  [fail] ${label}: avatar service returned no avatar`);
        continue;
      }

      user.profilePicture = result.avatar;
      user.avatarMetadata = {
        ...(user.avatarMetadata || {}),
        source: result.metadata?.source || 'unknown',
        model: result.metadata?.model || null,
        prompt: customPrompt,
        generatedAt: new Date(),
      };
      await user.save();

      const source = result.metadata?.source || 'unknown';
      const model = result.metadata?.model || 'n/a';
      const fallback = result.metadata?.fallbackUsed ? ' (fallback)' : '';
      sources[source] = (sources[source] || 0) + 1;
      generated += 1;
      console.log(`  [done] ${label}: ${source}/${model}${fallback}`);
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
  if (Object.keys(sources).length) {
    console.log(`  sources:   ${JSON.stringify(sources)}`);
  }
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
