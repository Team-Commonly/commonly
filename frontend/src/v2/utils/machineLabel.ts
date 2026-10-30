// Two computers can share a name (a reinstall registers a second one under the
// same hostname). A picker then needs something to tell them apart, so a name
// shared with another of the owner's computers gets the date it was added.
// A unique name is returned unchanged.
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
  const shared = all.some((other) => other.machineId !== machine.machineId && other.name === machine.name);
  if (!shared || !machine.createdAt) return machine.name;
  const date = new Date(machine.createdAt).toLocaleDateString(language, { month: 'short', day: 'numeric' });
  return `${machine.name} · ${t('agentByo.machine.addedOn', { date })}`;
}

// The list arrives sorted by lastSeenAt, newest first. Prefer the first online
// computer, so the default is the one that can take the agent right now.
export function defaultMachine<T extends { status: 'online' | 'offline' }>(machines: T[]): T | undefined {
  return machines.find((machine) => machine.status === 'online') ?? machines[0];
}
