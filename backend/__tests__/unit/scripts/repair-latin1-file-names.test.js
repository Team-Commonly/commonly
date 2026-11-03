const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const File = require('../../../models/File');
const { repairLatin1Name, maskName, repairFileNames } = require('../../../scripts/repair-latin1-file-names');

// What multer 2 stored before defParamCharset: the UTF-8 bytes read as latin1.
const garble = (name) => Buffer.from(name, 'utf8').toString('latin1');

describe('repairLatin1Name', () => {
  it.each([
    '2025年报告.doc',
    'résumé-café.png',
    'launch 🚀.png',
    'Ünïcødé – dash.pdf',
  ])('restores %s from its latin1 reading', (name) => {
    expect(repairLatin1Name(garble(name))).toBe(name);
  });

  it.each([
    ['plain ASCII', 'sheet-390-light.png'],
    ['a correct latin1 name', 'café.png'],
    ['a correct CJK name', '2025年报告.doc'],
    ['a correct emoji name', 'launch 🚀.png'],
    ['mixed bytes that are not valid UTF-8', 'Ã©té.png'],
    ['empty', ''],
    ['not a string', null],
  ])('leaves %s alone', (_label, name) => {
    expect(repairLatin1Name(name)).toBeNull();
  });

  it('masks all but the first two characters and the extension', () => {
    expect(maskName('2025年报告.doc')).toBe('20•••••.doc');
    expect(maskName('ab')).toBe('ab');
  });
});

describe('repairFileNames', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(clearMongoDb);

  const uploadedBy = new mongoose.Types.ObjectId();
  const seed = () => File.create([
    { fileName: 'a', originalName: garble('2025年报告.doc'), contentType: 'application/msword', size: 1, uploadedBy },
    { fileName: 'b', originalName: 'café.png', contentType: 'image/png', size: 1, uploadedBy },
    { fileName: 'c', originalName: 'plain.png', contentType: 'image/png', size: 1, uploadedBy },
    { fileName: 'd', originalName: '已经正确.png', contentType: 'image/png', size: 1, uploadedBy },
  ]);

  const names = async () => (await File.find({}).sort({ fileName: 1 }).lean()).map((f) => f.originalName);

  it('reports and writes nothing on a dry run', async () => {
    await seed();
    const before = await names();
    const lines = [];
    const report = await repairFileNames(File, { apply: false, log: (l) => lines.push(l) });
    expect(report).toEqual({ scanned: 2, repairable: 1, repaired: 0 });
    expect(await names()).toEqual(before);
    expect(lines.join('\n')).toContain('20•••••.doc');
    expect(lines.join('\n')).not.toContain('报告');
  });

  it('repairs only the garbled row on --apply, and a second run finds nothing', async () => {
    await seed();
    const report = await repairFileNames(File, { apply: true, log: () => {} });
    expect(report).toEqual({ scanned: 2, repairable: 1, repaired: 1 });
    expect(await names()).toEqual(['2025年报告.doc', 'café.png', 'plain.png', '已经正确.png']);
    expect(await repairFileNames(File, { apply: true, log: () => {} })).toEqual({ scanned: 1, repairable: 0, repaired: 0 });
  });
  it('skips a row renamed between the scan and the write, and counts only real writes', async () => {
    await seed();
    // A person renames the file after the scan has read it.
    const scanning = {
      find: (...args) => {
        const q = File.find(...args);
        return {
          select: (...s) => ({
            lean: async () => {
              const rows = await q.select(...s).lean();
              await File.updateOne({ fileName: 'a' }, { $set: { originalName: 'renamed.doc' } });
              return rows;
            },
          }),
        };
      },
      updateOne: (...args) => File.updateOne(...args),
    };
    const report = await repairFileNames(scanning, { apply: true, log: () => {} });
    expect(report).toEqual({ scanned: 2, repairable: 1, repaired: 0 });
    expect((await File.findOne({ fileName: 'a' }).lean()).originalName).toBe('renamed.doc');
  });
});
