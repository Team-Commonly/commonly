import Installable from '../../models/Installable';
import { PLAYBOOK_HANDLER } from './identity';
import { PlaybookError } from './definition';
import { createOffPlaybook, DraftInput, requirePlaybookHuman, validatePlaybookDraft } from './store';
import type { PlaybookSchedule } from './schedule';

type SeedMetadata = { playbook: unknown; sourceText?: string; schedule?: PlaybookSchedule };

const SEEDS: Array<{ id: string; draft: DraftInput }> = [
  { id: 'builtin-playbook-bug-fix', draft: { title: 'Bug to merged fix',
    sourceText: 'An agent opens a fix PR. An agent from another vendor reviews it. A person approves and merges by hand.',
    definition: { v: 1, roles: [{ key: 'fixer', kind: 'agent' }, { key: 'reviewer', kind: 'agent' },
      { key: 'approver', kind: 'person' }], steps: [
      { key: 'fix', title: 'Open the fix PR', role: 'fixer', do: 'Implement the supplied issue and open a pull request. '
        + 'Keep the PR link on this task before completing it.', delivers: 'pr' },
      { key: 'review', title: 'Review the fix', role: 'reviewer', do: 'Review the preceding PR. Use an agent from '
        + 'another vendor for an independent review. Complete this task after recording a pass in its PR thread.' },
      { key: 'merge', title: 'Merge by hand', role: 'approver', do: 'Approve the reviewed fix, merge it by hand, '
        + 'then complete this task.', approval: { by: 'approver', act: 'actor', effect: 'none' } },
    ], done: [{ says: 'Fix complete', check: 'done', step: 'fix' }, { says: 'PR linked', check: 'has-pr', step: 'fix' },
      { says: 'Review complete', check: 'done', step: 'review' }, { says: 'Approved', check: 'approved', step: 'merge' },
      { says: 'Merge recorded complete', check: 'done', step: 'merge' },
      { says: 'Completed by a person', check: 'by-person', step: 'merge' }] },
  } },
  { id: 'builtin-playbook-pipeline-review', draft: { title: 'Weekly pipeline review',
    sourceText: 'On Mondays at 09:00, review Airtable deals by stage and flag those untouched for 14 days. '
      + 'The owner approves the review, then files the agreed changes manually.',
    schedule: { cron: '0 9 * * 1', timezone: 'UTC' },
    definition: { v: 1, roles: [{ key: 'analyst', kind: 'agent' }, { key: 'owner', kind: 'person' }], steps: [
      { key: 'review', title: 'Review the pipeline', role: 'analyst', reads: ['airtable.list_records_for_table'], delivers: 'post',
        do: 'Read the supplied Airtable pipeline. Count deals by stage, flag deals untouched for 14 days, '
          + 'and post at most three items for the owner to decide.' },
      { key: 'approve', title: 'Approve the review', role: 'owner',
        do: 'Approve the changes to file manually.', approval: { by: 'owner', act: 'kernel', effect: 'none' } },
      { key: 'file', title: 'File the agreed changes', role: 'owner', writeGap: 'Airtable',
        do: 'File the agreed changes in Airtable by hand, then complete this task.' },
    ], done: [{ says: 'Review posted', check: 'done', step: 'review' },
      { says: 'Approved', check: 'approved', step: 'approve' },
      { says: 'Changes recorded complete', check: 'done', step: 'file' },
      { says: 'Completed by a person', check: 'by-person', step: 'file' }] },
  } },
];

/** Builtin manifests have no installation, schedule or agent identity until copied. */
export const seedPlaybookGallery = async (): Promise<void> => {
  for (const seed of SEEDS) {
    const { book, schedule } = validatePlaybookDraft(seed.draft);
    await Installable.updateOne({ installableId: seed.id, source: 'builtin' }, { $setOnInsert: {
      installableId: seed.id, name: seed.draft.title, version: '1.0.0', kind: 'app', scope: 'pod', source: 'builtin',
      description: seed.draft.sourceText, components: [{ name: 'playbook', type: 'event-handler',
        eventHandler: PLAYBOOK_HANDLER, metadata: { playbook: book, sourceText: seed.draft.sourceText,
          ...(schedule ? { schedule } : {}) } }],
    } }, { upsert: true, runValidators: true });
  }
};

export const listPlaybookGallery = async (podId: string, userId: string) => {
  await requirePlaybookHuman(podId, userId);
  const rows = await Installable.find({ source: 'builtin', installableId: { $in: SEEDS.map((seed) => seed.id) } }).lean();
  return rows.map((row) => {
    const metadata = row.components[0]?.metadata as unknown as SeedMetadata | undefined;
    return { id: row.installableId, title: row.name, description: row.description,
      definition: metadata?.playbook, scheduleCron: metadata?.schedule?.cron || null };
  });
};

export const copyGalleryPlaybook = async (podId: string, userId: string, seedId: string, timezone?: string) => {
  await requirePlaybookHuman(podId, userId);
  if (!SEEDS.some((seed) => seed.id === seedId)) throw new PlaybookError('seed_not_found', 'Playbook not found', 404);
  const seed = await Installable.findOne({ installableId: seedId, source: 'builtin' }).lean();
  const metadata = seed?.components.find((component) => component.eventHandler === PLAYBOOK_HANDLER)?.metadata as
    unknown as SeedMetadata | undefined;
  if (!seed || !metadata) throw new PlaybookError('seed_not_found', 'Playbook not found', 404);
  const installation = await createOffPlaybook(podId, userId, { title: seed.name, definition: metadata.playbook,
    sourceText: metadata.sourceText, ...(metadata.schedule
      ? { schedule: { cron: metadata.schedule.cron, timezone: timezone! } } : {}) });
  return installation;
};
