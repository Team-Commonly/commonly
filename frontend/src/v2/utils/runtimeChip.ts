// The short runtime tag after an agent's name in chat. `config --adapter` writes
// `runtime.adapter` and leaves `runtimeType: 'webhook'` on a CLI-wrapped seat,
// so the adapter names the CLI and `runtimeType` speaks only when no adapter is
// declared. Reading runtimeType first made every CLI seat read "webhook".
// `agent run --adapter` never writes runtime.adapter, so the CLI also reports
// its name (runtime.reportedCli, display only; TASK-317), and a BYO seat on an
// older CLI that reports nothing reads "CLI" rather than "webhook".
export interface RuntimeChipSource {
  adapter?: string | null;
  wrappedCli?: string | null;
  runtimeType?: string | null;
  host?: string | null;
  /** Display only: the CLI an unverified runtime said it runs (TASK-317). */
  reportedCli?: string | null;
}

const RUNTIME_TYPE_CHIP: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  openclaw: 'openclaw',
  moltbot: 'openclaw',
  internal: 'hosted',
  hosted: 'hosted',
  webhook: 'webhook',
};

const ADAPTER_CHIP: Record<string, string> = {
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  dsh: 'dsh',
};

const clean = (value: string | null | undefined): string => (value || '').trim().toLowerCase();

/** The chip text for an agent's runtime, or null when no runtime is known. */
export const runtimeChipLabel = (runtime?: RuntimeChipSource | null): string | null => {
  // Commonly runs a hosted seat, and install stamps its type. A config write can
  // still set runtime.adapter on it (configWriteGuard does not cover adapter), so
  // the kernel-owned type wins here: a hosted agent never shows a CLI chip.
  const runtimeType = clean(runtime?.runtimeType);
  if (runtimeType === 'hosted' || runtimeType === 'internal') return 'hosted';
  const adapter = clean(runtime?.adapter) || clean(runtime?.wrappedCli) || clean(runtime?.reportedCli);
  if (adapter) return ADAPTER_CHIP[adapter] || adapter;
  // A BYO seat on an older CLI reports nothing. It polls; it is not a webhook.
  if (runtimeType === 'webhook' && clean(runtime?.host) === 'byo') return 'CLI';
  return RUNTIME_TYPE_CHIP[runtimeType] || null;
};
