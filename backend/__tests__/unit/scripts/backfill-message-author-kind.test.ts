// @ts-nocheck

import { backfillMessageAuthorKind, MessageAuthorKindBackfillDeps } from '../../../scripts/backfill-message-author-kind';

const makeDeps = (overrides: Partial<MessageAuthorKindBackfillDeps> = {}): MessageAuthorKindBackfillDeps => ({
  getEpisodeReferences: async () => ['101', '507f1f77bcf86cd799439011', 'not-a-message'],
  getPostgresRows: async () => [{ id: 101, author_kind: null }],
  getMongoRows: async () => [{ _id: '507f1f77bcf86cd799439011', authorKind: null }],
  updatePostgresRows: async (ids) => ids.length,
  updateMongoRows: async (ids) => ids.length,
  ...overrides,
});

describe('backfill-message-author-kind', () => {
  it('reports both stores and writes nothing in the default dry run', async () => {
    const updatePostgresRows = jest.fn(async () => 1);
    const updateMongoRows = jest.fn(async () => 1);

    const report = await backfillMessageAuthorKind(makeDeps({ updatePostgresRows, updateMongoRows }));

    expect(report).toMatchObject({
      dryRun: true,
      episodeReferences: 3,
      uniqueMessageReferences: 3,
      postgresRows: 1,
      mongoRows: 1,
      invalidReferences: 1,
      missingReferences: 1,
      alreadyKernel: 0,
      toBackfill: 2,
      appliedPostgres: 0,
      appliedMongo: 0,
    });
    expect(updatePostgresRows).not.toHaveBeenCalled();
    expect(updateMongoRows).not.toHaveBeenCalled();
  });

  it('applies only unmarked rows and is idempotent by source-row state', async () => {
    const postgresRows = [
      { id: 101, author_kind: null },
      { id: 102, author_kind: 'kernel' },
    ];
    const mongoRows = [
      { _id: '507f1f77bcf86cd799439011', authorKind: null },
      { _id: '507f1f77bcf86cd799439012', authorKind: 'kernel' },
    ];
    const updatePostgresRows = jest.fn(async (ids: string[]) => ids.length);
    const updateMongoRows = jest.fn(async (ids: string[]) => ids.length);
    const deps = makeDeps({
      getEpisodeReferences: async () => ['101', '102', '507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
      getPostgresRows: async () => postgresRows,
      getMongoRows: async () => mongoRows,
      updatePostgresRows,
      updateMongoRows,
    });

    const first = await backfillMessageAuthorKind(deps, { apply: true });
    expect(first).toMatchObject({ dryRun: false, alreadyKernel: 2, toBackfill: 2, appliedPostgres: 1, appliedMongo: 1 });
    expect(updatePostgresRows).toHaveBeenCalledWith(['101']);
    expect(updateMongoRows).toHaveBeenCalledWith(['507f1f77bcf86cd799439011']);

    postgresRows[0].author_kind = 'kernel';
    mongoRows[0].authorKind = 'kernel';
    const second = await backfillMessageAuthorKind(deps, { apply: true });
    expect(second).toMatchObject({ alreadyKernel: 4, toBackfill: 0, appliedPostgres: 0, appliedMongo: 0 });
  });
});
