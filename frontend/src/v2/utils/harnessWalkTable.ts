// The harness walk table, as data. Source of truth: ~/agents/shared/d15/harness-walk-table.md
// (ux-lead, 2026-10-27). A harness is listed in the picker only when it has a passing walk on
// record. Change a row here only with a new walk on record, and update the table to match.

export type HarnessOsState = 'walked' | 'not-walked';

export interface HarnessWalkRow {
  id: string;
  label: string;
  /** Two-letter stand-in until the vendor's own mark is wired in. */
  monogram: string;
  /** `command` = one clipboard command; `terminal` = steps in your terminal. */
  connects: 'command' | 'terminal';
  os: { mac: HarnessOsState; linux: HarnessOsState; windows: HarnessOsState };
  /** Private pods only (lock glyph). */
  privatePodsOnly: boolean;
  walkedOn: string;
}

export const HARNESS_WALK_TABLE: readonly HarnessWalkRow[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    monogram: 'CC',
    connects: 'command',
    os: { mac: 'walked', linux: 'not-walked', windows: 'not-walked' },
    privatePodsOnly: false,
    walkedOn: '2026-10-26',
  },
  {
    id: 'codex',
    label: 'Codex',
    monogram: 'CX',
    connects: 'command',
    os: { mac: 'walked', linux: 'not-walked', windows: 'not-walked' },
    privatePodsOnly: false,
    walkedOn: '2026-10-27',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    monogram: 'OC',
    connects: 'terminal',
    os: { mac: 'walked', linux: 'not-walked', windows: 'not-walked' },
    privatePodsOnly: false,
    walkedOn: '2026-10-27',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    monogram: 'QW',
    connects: 'terminal',
    os: { mac: 'walked', linux: 'not-walked', windows: 'not-walked' },
    privatePodsOnly: false,
    walkedOn: '2026-10-27',
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    monogram: 'DS',
    connects: 'terminal',
    os: { mac: 'walked', linux: 'not-walked', windows: 'not-walked' },
    privatePodsOnly: true,
    walkedOn: '2026-10-23',
  },
];

/** Harnesses with no passing walk on record. They never render in the picker. */
export const HIDDEN_HARNESS_IDS: readonly string[] = ['hermes', 'goose', 'pi', 'gemini', 'grok-build'];
