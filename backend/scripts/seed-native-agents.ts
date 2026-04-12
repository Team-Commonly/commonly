// Throwaway seeder for the hello-world native agent used to validate the
// native runtime end-to-end. Retired when real first-party apps ship.
//
// Idempotent: safe to call on every server boot. All DB ops are upserts or
// presence checks. If the demo pod does not exist the whole seed is a no-op.

import mongoose from 'mongoose';
import { AgentRegistry, AgentInstallation } from '../models/AgentRegistry';
import { HELLO_NATIVE_AGENT } from '../config/native-agents/hello-native';

// Lazy require keeps this file import-safe even if dependent services move.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('../services/agentIdentityService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');

const DEMO_POD_ID = '69dade8019b75dc81f51f318'; // Team Orchestration Demo pod
const INSTALLED_BY_USER_ID = '67a9ceb240f8f53015944a05'; // xcjsam admin
const VERSION = '1.0.0';

export async function seedNativeAgents(): Promise<void> {
  console.log('[native-seed] ensuring hello-native registry row');
  try {
    await AgentRegistry.findOneAndUpdate(
      { agentName: HELLO_NATIVE_AGENT.agentName },
      {
        $set: {
          displayName: HELLO_NATIVE_AGENT.displayName,
          description: HELLO_NATIVE_AGENT.description,
          iconUrl: HELLO_NATIVE_AGENT.iconUrl,
          registry: 'commonly-official',
          verified: true,
          status: 'active',
          categories: HELLO_NATIVE_AGENT.categories,
          manifest: {
            name: HELLO_NATIVE_AGENT.agentName,
            version: VERSION,
            description: HELLO_NATIVE_AGENT.description,
          },
          latestVersion: VERSION,
        },
        $setOnInsert: {
          stats: { installs: 0, weeklyInstalls: 0, rating: 0, ratingCount: 0 },
          versions: [
            {
              version: VERSION,
              manifest: {
                name: HELLO_NATIVE_AGENT.agentName,
                version: VERSION,
                description: HELLO_NATIVE_AGENT.description,
              },
              publishedAt: new Date(),
            },
          ],
        },
      },
      { upsert: true, new: true },
    );
  } catch (err: any) {
    console.error('[native-seed] failed to upsert registry row:', err?.message || err);
    return;
  }

  // 2. Demo pod must exist; if not, skip the install step gracefully.
  const podObjectId = new mongoose.Types.ObjectId(DEMO_POD_ID);
  const pod = await Pod.findById(podObjectId);
  if (!pod) {
    console.log(
      `[native-seed] demo pod ${DEMO_POD_ID} not found — skipping installation seed`,
    );
    return;
  }

  console.log('[native-seed] upserting hello-native agent user');
  let agentUser;
  try {
    agentUser = await AgentIdentityService.getOrCreateAgentUser('hello-native', {
      instanceId: 'default',
      displayName: HELLO_NATIVE_AGENT.displayName,
    });
  } catch (err: any) {
    console.error('[native-seed] failed to create agent user:', err?.message || err);
    return;
  }

  console.log('[native-seed] upserting hello-native AgentInstallation');
  try {
    await AgentInstallation.findOneAndUpdate(
      {
        agentName: HELLO_NATIVE_AGENT.agentName,
        podId: podObjectId,
        instanceId: 'default',
      },
      {
        $setOnInsert: {
          agentName: HELLO_NATIVE_AGENT.agentName,
          podId: podObjectId,
          instanceId: 'default',
          displayName: HELLO_NATIVE_AGENT.displayName,
          version: VERSION,
          installedBy: new mongoose.Types.ObjectId(INSTALLED_BY_USER_ID),
          scopes: ['context:read', 'messages:write'],
          config: {
            runtime: { runtimeType: 'native' },
            systemPrompt: HELLO_NATIVE_AGENT.systemPrompt,
            model: HELLO_NATIVE_AGENT.model,
          },
        },
        $set: { status: 'active' },
      },
      { upsert: true, new: true },
    );
  } catch (err: any) {
    console.error('[native-seed] failed to upsert installation:', err?.message || err);
    return;
  }

  // 3. Ensure the agent user is a plain-ObjectId member of the pod.
  try {
    const agentIdStr = String(agentUser._id);
    const alreadyMember = (pod.members || []).some(
      (m: unknown) => String(m) === agentIdStr,
    );
    if (!alreadyMember) {
      pod.members.push(agentUser._id);
      await pod.save();
      console.log('[native-seed] added hello-native to demo pod members');
    } else {
      console.log('[native-seed] hello-native already in demo pod members');
    }
  } catch (err: any) {
    console.error(
      '[native-seed] failed to ensure pod membership:',
      err?.message || err,
    );
    // non-fatal — don't throw
  }

  console.log('[native-seed] done');
}

// CJS compat so `require('./scripts/seed-native-agents').seedNativeAgents(...)`
// works the same as the rest of the backend.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { seedNativeAgents };
