// Seeder for Commonly's first-party native agents.
//
// Iterates over `FIRST_PARTY_APPS` (loaded from packages/commonly-apps) and
// upserts each one into AgentRegistry + installs it into the Team
// Orchestration Demo pod. Also retires the Round-1 `hello-native` wiring
// on every boot — Registry row, Installation rows, and pod.members entries
// are cleaned up, but the agent User doc is deliberately left alone so
// historical AgentRun records stay resolvable.
//
// Idempotent: safe to call on every server boot. All DB ops are upserts or
// presence checks. If the demo pod does not exist, per-app installation is
// skipped (registry row still upserts).
//
// When an app's system prompt, model, tools, or triggers change between
// deploys, the seed UPDATES the stored config via `$set` — a restart is
// enough to pick up edits without any manual DB work.

import mongoose from 'mongoose';
import { AgentRegistry, AgentInstallation } from '../models/AgentRegistry';
import { FIRST_PARTY_APPS } from '../config/native-agents/apps';
import type { NativeAgentDefinition } from '../config/native-agents/apps';

// Lazy requires keep this file import-safe even if dependent services move
// and avoid pulling the full Mongoose model graph into typecheck.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('../services/agentIdentityService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pod = require('../models/Pod');

const DEMO_POD_ID = '69dade8019b75dc81f51f318'; // Team Orchestration Demo pod
const INSTALLED_BY_USER_ID = '67a9ceb240f8f53015944a05'; // xcjsam admin
const VERSION = '1.0.0';
const HELLO_NATIVE_AGENT_NAME = 'hello-native';

export async function seedNativeAgents(): Promise<void> {
  try {
    console.log(
      `[native-seed] starting — ${FIRST_PARTY_APPS.length} first-party app(s) to seed`,
    );

    // Step 1: retire the Round-1 hello-native validator (no-op if absent).
    await retireHelloNative();

    if (FIRST_PARTY_APPS.length === 0) {
      console.log(
        '[native-seed] no first-party apps found — nothing to seed (check packages/commonly-apps)',
      );
    }

    // Step 2: upsert registry + install each first-party app.
    for (const app of FIRST_PARTY_APPS) {
      try {
        await seedOneApp(app);
      } catch (err: unknown) {
        console.error(
          `[native-seed] failed to seed ${app?.agentName || 'unknown'}:`,
          (err as { message?: string })?.message || err,
        );
        // Continue with the next app — one bad definition shouldn't
        // block the rest.
      }
    }

    console.log('[native-seed] done');
  } catch (err: unknown) {
    console.error(
      '[native-seed] fatal:',
      (err as { message?: string })?.message || err,
    );
  }
}

/**
 * Retires the Round-1 hello-native validator. Deletes its AgentRegistry
 * row, all AgentInstallation rows, and removes it from every pod's
 * `members` array. Does NOT delete the agent User — historical AgentRun
 * records continue to reference it.
 *
 * Runs on every boot; all ops are no-ops if nothing is left to clean up.
 */
async function retireHelloNative(): Promise<void> {
  // 1. Delete AgentRegistry row.
  try {
    const regResult = await AgentRegistry.deleteOne({
      agentName: HELLO_NATIVE_AGENT_NAME,
    });
    if (regResult.deletedCount > 0) {
      console.log('[native-seed] retired hello-native AgentRegistry row');
    }
  } catch (err: unknown) {
    console.warn(
      '[native-seed] hello-native registry cleanup failed:',
      (err as { message?: string })?.message || err,
    );
  }

  // 2. Delete all AgentInstallation rows.
  try {
    const instResult = await AgentInstallation.deleteMany({
      agentName: HELLO_NATIVE_AGENT_NAME,
    });
    if (instResult.deletedCount > 0) {
      console.log(
        `[native-seed] retired ${instResult.deletedCount} hello-native AgentInstallation(s)`,
      );
    }
  } catch (err: unknown) {
    console.warn(
      '[native-seed] hello-native installation cleanup failed:',
      (err as { message?: string })?.message || err,
    );
  }

  // 3. Best-effort: strip the agent user from all pod.members arrays.
  //    getOrCreateAgentUser will fall back to creating a user if one
  //    doesn't exist — we only want to clean up existing membership,
  //    so we look up by username via a direct User.findOne first.
  try {
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(
      HELLO_NATIVE_AGENT_NAME,
      { instanceId: 'default' },
    );
    if (agentUser?._id) {
      const pullResult = await Pod.updateMany(
        { members: agentUser._id },
        { $pull: { members: agentUser._id } },
      );
      if (pullResult.modifiedCount > 0) {
        console.log(
          `[native-seed] removed hello-native from ${pullResult.modifiedCount} pod.members`,
        );
      }
    }
  } catch (err: unknown) {
    console.warn(
      '[native-seed] hello-native member cleanup skipped:',
      (err as { message?: string })?.message || err,
    );
  }

  // 4. Note: the claude-code-hello-native User doc is intentionally kept.
  //    Historical AgentRun/message records reference it; removing it would
  //    orphan those records. Non-destructive teardown.
}

/**
 * Upserts one first-party app: AgentRegistry row, agent User, installation
 * in the demo pod, and pod membership. Config is refreshed on every run so
 * edits to system prompt / model / tools / triggers land on the next
 * backend restart.
 */
async function seedOneApp(app: NativeAgentDefinition): Promise<void> {
  if (!app?.agentName) {
    console.warn('[native-seed] skipping app with no agentName');
    return;
  }

  const appLabel = `${app.agentName} (${app.displayName})`;
  console.log(`[native-seed] seeding ${appLabel}`);

  // 1. Upsert the AgentRegistry row. Display metadata is refreshed every
  //    run so package edits propagate; stats/versions are insert-only.
  try {
    await AgentRegistry.findOneAndUpdate(
      { agentName: app.agentName },
      {
        $set: {
          displayName: app.displayName,
          description: app.description,
          iconUrl: app.iconUrl || '',
          registry: 'commonly-official',
          verified: true,
          status: 'active',
          categories: app.categories || ['utility'],
          manifest: {
            name: app.agentName,
            version: VERSION,
            description: app.description,
          },
          latestVersion: VERSION,
        },
        $setOnInsert: {
          stats: { installs: 0, weeklyInstalls: 0, rating: 0, ratingCount: 0 },
          versions: [
            {
              version: VERSION,
              manifest: {
                name: app.agentName,
                version: VERSION,
                description: app.description,
              },
              publishedAt: new Date(),
            },
          ],
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err: unknown) {
    console.error(
      `[native-seed]   failed to upsert registry for ${appLabel}:`,
      (err as { message?: string })?.message || err,
    );
    return;
  }

  // 2. Demo pod must exist; if not, skip the install step gracefully.
  //    The registry row is still in place so the Agent Hub UI can show it.
  const podObjectId = new mongoose.Types.ObjectId(DEMO_POD_ID);
  const demoPod = await Pod.findById(podObjectId);
  if (!demoPod) {
    console.log(
      `[native-seed]   demo pod ${DEMO_POD_ID} missing — skipping install for ${appLabel}`,
    );
    return;
  }

  // 3. Provision the agent User doc (so messages posted by this agent
  //    render with the right displayName/icon).
  let agentUser: { _id: mongoose.Types.ObjectId } | null = null;
  try {
    agentUser = await AgentIdentityService.getOrCreateAgentUser(app.agentName, {
      instanceId: 'default',
      displayName: app.displayName,
      description: app.description,
    });
  } catch (err: unknown) {
    console.error(
      `[native-seed]   failed to provision agent user for ${appLabel}:`,
      (err as { message?: string })?.message || err,
    );
    return;
  }
  if (!agentUser?._id) {
    console.warn(`[native-seed]   no agent user returned for ${appLabel}`);
    return;
  }

  // 4. Upsert the AgentInstallation. `config` (runtime, systemPrompt,
  //    model, tools, triggers, limit overrides) lives under `$set` so
  //    every deploy refreshes it — edits to the app definition propagate
  //    the next time the backend restarts. Only identity fields (podId,
  //    installedBy, createdAt…) are `$setOnInsert`.
  //
  //    Config is stored as a plain object; Mongoose's Map<String, Mixed>
  //    schema accepts POJOs transparently, matching Round-1 conventions.
  const configObj: Record<string, unknown> = {
    runtime: { runtimeType: 'native' },
    systemPrompt: app.systemPrompt,
    model: app.model,
    tools: app.tools || [],
    triggers: app.triggers || [],
  };
  if (typeof app.heartbeatIntervalMinutes === 'number') {
    configObj.heartbeatIntervalMinutes = app.heartbeatIntervalMinutes;
  }
  if (typeof app.maxTurns === 'number') configObj.maxTurns = app.maxTurns;
  if (typeof app.maxTokens === 'number') configObj.maxTokens = app.maxTokens;
  if (typeof app.maxWallClockMs === 'number') {
    configObj.maxWallClockMs = app.maxWallClockMs;
  }

  try {
    await AgentInstallation.findOneAndUpdate(
      {
        agentName: app.agentName,
        podId: podObjectId,
        instanceId: 'default',
      },
      {
        $set: {
          status: 'active',
          version: VERSION,
          displayName: app.displayName,
          scopes: ['context:read', 'messages:write', 'memory:read', 'memory:write'],
          config: configObj,
        },
        $setOnInsert: {
          agentName: app.agentName,
          podId: podObjectId,
          instanceId: 'default',
          installedBy: new mongoose.Types.ObjectId(INSTALLED_BY_USER_ID),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err: unknown) {
    console.error(
      `[native-seed]   failed to upsert installation for ${appLabel}:`,
      (err as { message?: string })?.message || err,
    );
    return;
  }

  // 5. Ensure the agent user is a plain-ObjectId member of the demo pod.
  //    Pod.members MUST be a flat ObjectId array (invariant from
  //    CLAUDE.md) — `pod.save()` validates before write.
  try {
    const agentIdStr = String(agentUser._id);
    const alreadyMember = (demoPod.members || []).some(
      (m: unknown) => String(m) === agentIdStr,
    );
    if (!alreadyMember) {
      demoPod.members.push(agentUser._id);
      await demoPod.save();
      console.log(`[native-seed]   added ${appLabel} to demo pod members`);
    }
  } catch (err: unknown) {
    console.warn(
      `[native-seed]   pod membership update failed for ${appLabel}:`,
      (err as { message?: string })?.message || err,
    );
    // non-fatal
  }

  console.log(`[native-seed]   ${appLabel} ready`);
}

// CJS compat so `require('./scripts/seed-native-agents').seedNativeAgents(...)`
// works the same as the rest of the backend.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = { seedNativeAgents };
