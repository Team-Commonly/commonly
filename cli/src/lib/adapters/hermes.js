import { homedir } from 'os';
import { join } from 'path';
import { createHermesAdapter } from '@commonlyai/seats/adapters/hermes';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { effectiveSandboxTrust } from '../environment.js';
import { seatModelRequired } from './seat-model.js';

export { TESTED_HERMES_VERSION, readHermesJsonl } from '@commonlyai/seats/adapters/hermes';

// Commonly's policy for the generic Hermes adapter: its memory preamble, its
// legacy sandbox-trust names, the fleet seat-model switch, and the profile
// directory seats have always used.
export default createHermesAdapter({
  memoryPreamble: buildMemoryPreamble,
  effectiveTrust: effectiveSandboxTrust,
  seatModelRequired,
  profileRoot: join(homedir(), '.commonly', 'hermes', 'profiles'),
});
