/**
 * F427: a computer can run a second instance of an agent only once its daemon
 * keeps a local key per instance. That shipped in CLI 0.1.328; an older daemon
 * keeps one key per agent name and refuses the second instance. The version is
 * the one the daemon reports on each check-in (null for a daemon too old to
 * report one), read beside its own running code, so an upgraded package whose
 * daemon has not restarted still reads as the old version.
 */
export const INSTANCE_KEYS_CLI_VERSION = '0.1.328';

const parse = (version: string): [number, number, number, boolean] | null => {
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(-.+)?$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Boolean(match[4])] : null;
};

export const keepsInstanceKeys = (cliVersion: string | null | undefined): boolean => {
  if (typeof cliVersion !== 'string') return false;
  const have = parse(cliVersion);
  const need = parse(INSTANCE_KEYS_CLI_VERSION);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return (have[i] as number) > (need[i] as number);
  }
  // A prerelease of the first version (0.1.328-rc.1) comes before it.
  return !have[3];
};
