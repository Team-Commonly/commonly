/**
 * officeContentValidator — refuse empty .docx / .xlsx / .pptx uploads.
 *
 * Why this exists: agents using the bundled `officecli` skill have a
 * recurring bug where they `officecli create file.docx` + `officecli
 * close file.docx` without any `add` calls in between. The result is a
 * structurally-valid OOXML file with zero content (`<w:body/>`,
 * `<sheetData/>`, `<sldIdLst/>`). Theo's three demo deliverables on
 * 2026-05-06 (`demo-brief.docx`, `demo-data.xlsx`, `demo-pitch.pptx`)
 * were all empty for exactly this reason — the model took the shortest
 * `create → close` path and declared success.
 *
 * The bundled SKILL.md does include a "Delivery Gate" telling agents
 * to verify content before declaring done. Models routinely skip it.
 * Enforcing the gate at the kernel layer (upload time) makes the bug
 * impossible to ignore — the upload returns 422 with a clear error,
 * forcing the agent to actually populate the document and retry.
 *
 * Applied **only to agent uploads** (the `/api/agents/runtime/pods/
 * :podId/uploads` route). Human uploads via `/api/uploads` stay
 * permissive — humans may legitimately upload empty templates.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require('adm-zip');

interface OfficeValidationResult {
  ok: boolean;
  format: 'docx' | 'xlsx' | 'pptx' | 'unknown';
  reason?: string;
}

const isOfficeFilename = (originalName: string): boolean =>
  /\.(docx|xlsx|pptx)$/i.test(originalName);

const validateDocx = (entries: any[]): OfficeValidationResult => {
  const docXml = entries.find((e: any) => e.entryName === 'word/document.xml');
  if (!docXml) {
    return { ok: false, format: 'docx', reason: 'missing word/document.xml' };
  }
  const text = docXml.getData().toString('utf8');
  // A docx with only section properties (`<w:sectPr>`) but no text runs
  // (`<w:t>`) is empty. Officecli's bare `create` produces exactly that.
  // Also accept content via `<w:r>` with non-trivial children, but `<w:t>`
  // is the canonical text container.
  if (!/<w:t[\s>]/.test(text)) {
    return { ok: false, format: 'docx', reason: 'document body has no text runs (`<w:t>`)' };
  }
  return { ok: true, format: 'docx' };
};

const validateXlsx = (entries: any[]): OfficeValidationResult => {
  const sheets = entries.filter((e: any) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName));
  if (sheets.length === 0) {
    return { ok: false, format: 'xlsx', reason: 'no worksheets present' };
  }
  // At least ONE sheet must have at least one cell. An xlsx with all
  // sheets empty (`<sheetData/>` with no `<row>`) is what officecli
  // emits when called with no add steps.
  for (const s of sheets) {
    const text = s.getData().toString('utf8');
    if (/<row[\s>]/.test(text) || /<c\s/.test(text)) {
      return { ok: true, format: 'xlsx' };
    }
  }
  return { ok: false, format: 'xlsx', reason: 'all worksheets are empty (`<sheetData/>` with no rows)' };
};

const validatePptx = (entries: any[]): OfficeValidationResult => {
  const presXml = entries.find((e: any) => e.entryName === 'ppt/presentation.xml');
  if (!presXml) {
    return { ok: false, format: 'pptx', reason: 'missing ppt/presentation.xml' };
  }
  const text = presXml.getData().toString('utf8');
  // sldIdLst contains one <p:sldId> per slide. Self-closing `<p:sldIdLst/>`
  // means zero slides — the deck is structurally a presentation but has
  // no content.
  const slideIdMatch = text.match(/<p:sldIdLst[^>]*>([\s\S]*?)<\/p:sldIdLst>/);
  const slideIdContent = slideIdMatch?.[1] ?? '';
  if (!/<p:sldId[\s/>]/.test(slideIdContent)) {
    return { ok: false, format: 'pptx', reason: 'deck has zero slides (`<p:sldIdLst/>`)' };
  }
  return { ok: true, format: 'pptx' };
};

/**
 * Validate that an Office file (docx/xlsx/pptx) has actual content.
 *
 * Returns `{ok: true}` for non-Office files (passes through) and for
 * Office files whose structure shows real content. Returns
 * `{ok: false, reason}` for the empty-stub case the agent shortcut
 * produces.
 *
 * Throws are swallowed — a malformed/corrupt zip returns `{ok: true}`
 * because we can't make a confident empty/non-empty determination, and
 * we'd rather not block legitimate uploads on a parser hiccup.
 */
export const validateOfficeContent = (
  buffer: Buffer,
  originalName: string,
): OfficeValidationResult => {
  if (!isOfficeFilename(originalName)) {
    return { ok: true, format: 'unknown' };
  }
  let entries: any[];
  try {
    const zip = new AdmZip(buffer);
    entries = zip.getEntries();
  } catch {
    // Not a parseable zip — let it through; downstream code will
    // surface the corruption when an agent tries to read it.
    return { ok: true, format: 'unknown' };
  }

  if (/\.docx$/i.test(originalName)) return validateDocx(entries);
  if (/\.xlsx$/i.test(originalName)) return validateXlsx(entries);
  if (/\.pptx$/i.test(originalName)) return validatePptx(entries);
  return { ok: true, format: 'unknown' };
};

// CommonJS interop
module.exports = { validateOfficeContent };
module.exports.validateOfficeContent = validateOfficeContent;
