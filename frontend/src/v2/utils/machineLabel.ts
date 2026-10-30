// Two computers can share a name (a reinstall registers a second one under the
// same hostname). A picker then needs something to tell them apart, so a name
// shared with another of the owner's computers gets when it was added. Two
// added in the same minute, or with no timestamp, fall back to the tail of the
// machine ID. A unique name is returned unchanged.
export interface NamedMachine {
  machineId: string;
  name: string;
  createdAt?: string | null;
}

type Translate = (key: string, options?: Record<string, string>) => string;

export function machineDisplayName(
  machine: NamedMachine,
  all: NamedMachine[],
  t: Translate,
  language: string,
): string {
  const shared = all.filter((other) => other.machineId !== machine.machineId && other.name === machine.name);
  if (shared.length === 0) return machine.name;
  const idTail = machine.machineId.slice(-4);
  if (!machine.createdAt) return `${machine.name} · ${idTail}`;
  const addedAt = (m: NamedMachine) => new Date(m.createdAt as string).toLocaleString(language, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const stamp = addedAt(machine);
  const collides = shared.some((other) => other.createdAt && addedAt(other) === stamp);
  return collides
    ? `${machine.name} · ${t('agentByo.machine.addedOn', { date: stamp })} · ${idTail}`
    : `${machine.name} · ${t('agentByo.machine.addedOn', { date: stamp })}`;
}

// The list arrives sorted by lastSeenAt, newest first. Prefer the first online
// computer, so the default is the one that can take the agent right now.
export function defaultMachine<T extends { status: 'online' | 'offline' }>(machines: T[]): T | undefined {
  return machines.find((machine) => machine.status === 'online') ?? machines[0];
}
