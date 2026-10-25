import User from '../models/User';
import Machine from '../models/Machine';
import { normalizeRuntimeInventory, WALKED_HARNESSES } from './runtimeInventory';

// Validate controls only when a bound daemon supplies a machine inventory.
// Existing/standalone installations keep working against older daemons.
export const runtimeControlRefusal = async ({ agentName, instanceId, ownerUserId, config, effectiveHarness }: {
  agentName: string; instanceId: string; ownerUserId: string; config: any; effectiveHarness?: string;
}): Promise<string | null> => {
  const environment = config?.environment || {};
  const requestedHarness = config?.runtime?.adapter;
  if (requestedHarness === undefined && environment.model === undefined
    && environment.effort === undefined) return null;
  if (environment.model !== undefined && (typeof environment.model !== 'string'
    || !environment.model.trim() || environment.model.length > 256)) return 'Model must be 1–256 characters';
  const chosen = requestedHarness || effectiveHarness;
  const harness = chosen === 'claude-code' ? 'claude' : chosen;
  // Machine inventory intentionally describes only walked adapters. Keep the
  // existing configuration path for all other adapters, including legacy rows.
  if (!harness || !(WALKED_HARNESSES as readonly string[]).includes(harness)) return null;
  const binding = await User.findOne({ isBot: true, 'botMetadata.agentName': agentName,
    'botMetadata.instanceId': instanceId }).select('botMetadata.machineId').lean();
  if (!binding?.botMetadata?.machineId) return null;
  const machine = await Machine.findOne({ machineId: binding.botMetadata.machineId, ownerUserId })
    .select('runtimeInventory inventoryAt agentStates').lean();
  if (!machine?.inventoryAt) {
    if (requestedHarness && requestedHarness !== effectiveHarness) {
      return 'This computer has not reported installed harnesses';
    }
    return environment.effort ? 'This computer has not reported effort levels; choose harness default' : null;
  }
  const inventory = normalizeRuntimeInventory(machine.runtimeInventory) || [];
  const selected = inventory.find((row) => row.harness === harness);
  if (!selected?.installed) return 'The requested harness is not installed on this computer';
  if (selected.models?.length && environment.model !== undefined && !selected.models.includes(environment.model)) {
    return 'The requested model is not reported by this harness';
  }
  if (environment.effort && !selected.efforts.includes(environment.effort)) {
    return 'The requested effort is not reported by this harness';
  }
  return null;
};
