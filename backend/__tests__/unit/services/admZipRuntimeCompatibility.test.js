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

// An entry whose declared size is over the cap is never inflated: the check
// passes the file instead of reading gigabytes into memory.
describe('validateOfficeContent inflate cap', () => {
  const AdmZip = require('adm-zip');
  const { validateOfficeContent, OFFICE_ENTRY_INFLATE_MAX } = require('../../../services/officeContentValidator');

  // The same empty deck the next test refuses, with its central directory
  // declaring the entry over the cap: it passes, so it was never read.
  it('passes a deck with an oversized entry unread', () => {
    const zip = new AdmZip();
    zip.addFile('ppt/presentation.xml', Buffer.from('<p:presentation><p:sldIdLst/></p:presentation>'));
    const buffer = zip.toBuffer();
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buffer.writeUInt32LE(OFFICE_ENTRY_INFLATE_MAX + 1, central + 24);
    expect(validateOfficeContent(buffer, 'deck.pptx')).toEqual({ ok: true, format: 'unknown' });
  });

  it('still refuses an empty deck under the cap', () => {
    const zip = new AdmZip();
    zip.addFile('ppt/presentation.xml', Buffer.from('<p:presentation><p:sldIdLst/></p:presentation>'));
    expect(validateOfficeContent(zip.toBuffer(), 'deck.pptx').ok).toBe(false);
  });
});
