const AdmZip = require('adm-zip');
const { validateOfficeContent } = require('../../../services/officeContentValidator');
const SkillsCatalogService = require('../../../services/skillsCatalogService');

const realFetch = global.fetch;

const asArrayBuffer = (buffer) => buffer.buffer.slice(
  buffer.byteOffset,
  buffer.byteOffset + buffer.byteLength,
);

describe('adm-zip runtime consumers', () => {
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('office validation reads entries from a Buffer archive', () => {
    const zip = new AdmZip();
    zip.addFile(
      'word/document.xml',
      Buffer.from('<w:document><w:body><w:p><w:r><w:t>filled</w:t></w:r></w:p></w:body></w:document>'),
    );

    expect(validateOfficeContent(zip.toBuffer(), 'filled.docx')).toEqual({
      ok: true,
      format: 'docx',
    });
  });

  test('ClawHub bundle loading reads the skill and extra files as text', async () => {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# Example skill'));
    zip.addFile('references/guide.md', Buffer.from('Reference text'));
    const archive = asArrayBuffer(zip.toBuffer());

    // Real Responses: the download streams its body through the fetch guard.
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ latestVersion: { version: '1.2.3' } })))
      .mockResolvedValueOnce(new Response(Buffer.from(archive)));

    const result = await SkillsCatalogService.fetchSkillBundleFromClawHub('owner', 'example');

    expect(result).toEqual({
      content: '# Example skill',
      extraFiles: [{ path: 'references/guide.md', content: 'Reference text' }],
      resolvedUrl: 'clawhub:owner/example@1.2.3',
      version: '1.2.3',
    });
  });
});
