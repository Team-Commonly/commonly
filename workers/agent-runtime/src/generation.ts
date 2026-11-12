// F291: the storage a poll and its turns write through. /deprovision runs
// storage.deleteAll(), but a turn still running from before can resume after
// it and write its transcript, staged reply or poll stamps back, and a later
// /provision would then pick that transcript up. So every write first checks
// that this object is still the provisioning the poll started under: the
// runtime token is there and the generation /provision stored is unchanged.
// A storage get or put does not open the DO's input gate, so no request runs
// between that check and the write.
import type { StagingStorage } from './staging';

export const GENERATION_KEY = 'generation';

export interface GenerationStorage extends StagingStorage {
  /** False once this object was deprovisioned or provisioned again. */
  current(): Promise<boolean>;
}

export const generationStorage = (
  storage: StagingStorage,
  generation: string | undefined,
): GenerationStorage => {
  const current = async (): Promise<boolean> => {
    const [token, stored] = await Promise.all([
      storage.get<string>('runtimeToken'),
      storage.get<string>(GENERATION_KEY),
    ]);
    return Boolean(token) && stored === generation;
  };
  return {
    current,
    get: (key) => storage.get(key),
    list: (options) => storage.list(options),
    put: async (key, value) => {
      if (await current()) await storage.put(key, value);
    },
    delete: async (key) => ((await current()) ? storage.delete(key) : false),
  };
};
