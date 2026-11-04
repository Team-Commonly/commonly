// D247: the one list of harnesses `commonly agent run --adapter` accepts
// (cli/src/lib/adapters/index.js), with the models and effort levels each
// takes. The add-agent page and Settings both read it, so a new model is a
// one-line change here.
//
// `models` holds full ids, the exact value passed to the harness. A list is
// here only where each id was run once against the harness (Claude Code
// 2.1.318 `--model`, codex-cli 0.162.1 `-m`, 2026-11-04); null means no fixed
// list, and the person types the id. A device's own report replaces both
// lists once it arrives.
//
// `efforts` is the ladder the adapter passes on: claude `--effort`, codex
// `model_reasoning_effort`, pi `--thinking` (its ladder minus `off`), dsh
// `reasoning` (the keys of its reasoningEfforts map). [] means the adapter has
// no effort flag, or one whose accepted values the code does not pin
// (opencode `--variant`).
export interface HarnessCatalogEntry {
  id: string;
  label: string;
  models: string[] | null;
  efforts: string[];
}

const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

export const HARNESS_CATALOG: readonly HarnessCatalogEntry[] = Object.freeze([
  { id: 'claude', label: 'Claude Code',
    models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], efforts: LADDER },
  { id: 'codex', label: 'Codex',
    models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
      'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    efforts: LADDER },
  { id: 'opencode', label: 'OpenCode', models: null, efforts: [] },
  { id: 'qwen', label: 'Qwen Code', models: null, efforts: [] },
  { id: 'goose', label: 'Goose', models: null, efforts: [] },
  { id: 'hermes', label: 'Hermes', models: null, efforts: [] },
  { id: 'pi', label: 'pi', models: null, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'dsh', label: 'DeepSeek Harness', models: null, efforts: LADDER },
].map((entry) => Object.freeze({ ...entry,
  models: entry.models ? Object.freeze([...entry.models]) as string[] : null,
  efforts: Object.freeze([...entry.efforts]) as string[] })));

export const harnessCatalogEntry = (id: unknown): HarnessCatalogEntry | null => {
  const key = id === 'claude-code' ? 'claude' : id;
  return HARNESS_CATALOG.find((entry) => entry.id === key) || null;
};

