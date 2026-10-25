import File from '../models/File';
import { getObjectStore } from './objectStore';

export class PodFileReadError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const AGENT_FILE_TEXT_MAX = 256 * 1024; // 256 KB cap on inlined text

// Textual subtypes, matched as WHOLE TOKENS against the parsed subtype —
// never as substrings of the raw header.
//
// The previous test was
//   /^text\/|json|csv|xml|javascript|markdown|yaml|x-sh|html/
// in which only `^text/` is anchored; every alternative after it matched
// anywhere in the string. `application/vnd.openXMLformats-officedocument.
// wordprocessingml.document` contains "xml", so .docx/.xlsx/.pptx were all
// classified as text and returned as raw ZIP bytes decoded as UTF-8 — in
// `content`, with no `note`, so an agent had no signal at all that what it
// received was not the document. Measured 2026-08-05: a 939-byte .docx came
// back as "PK\x03\x04…". That is worse than refusing, because a refusal is
// legible and this is not. See AX audit entry 19.
//
// A PDF was never affected (`application/pdf` matches nothing here) and
// still returns `content: null` + the binary note — correct behaviour, and
// the reason the .docx case went unnoticed: the format everyone tested
// failed honestly.
const TEXTUAL_SUBTYPES = new Set([
  'json', 'csv', 'tsv', 'xml', 'javascript', 'ecmascript', 'markdown', 'md',
  'yaml', 'x-yaml', 'x-sh', 'html', 'xhtml', 'plain', 'sql', 'toml', 'ini',
]);

const isTextualContentType = (raw: string): boolean => {
  // Strip parameters (`; charset=utf-8`) before splitting type/subtype.
  const [type, subtype = ''] = String(raw || '').split(';')[0].trim().toLowerCase().split('/');
  if (type === 'text') return true;
  if (TEXTUAL_SUBTYPES.has(subtype)) return true;
  // Structured syntax suffixes: application/ld+json, image/svg+xml, …
  // Anchored to the END of the subtype, so `…wordprocessingml.document`
  // cannot match on a bare "+xml" that isn't a suffix.
  return /\+(json|xml)$/.test(subtype);
};

/** Shared text-only reader. Callers must authorize the current pod member first. */
export const readPodFileText = async (podId: string, fileName: string) => {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) throw new PodFileReadError('Invalid file name', 400);
  const file = await File.findOne({ fileName, podId })
    .select('fileName originalName contentType size')
    .lean() as any;
  if (!file) {
    throw new PodFileReadError('File not found in this pod', 404);
  }

  // Fetch bytes: object store first, legacy inline data as fallback.
  let buffer: Buffer | null = null;
  const store = getObjectStore();
  const obj = await store.get(fileName);
  if (obj && obj.stream) {
    buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      obj.stream.on('data', (c: Buffer) => chunks.push(c));
      obj.stream.on('end', () => resolve(Buffer.concat(chunks)));
      obj.stream.on('error', reject);
    });
  } else {
    const legacy = await File.findOne({ _id: file._id, podId }).select('data');
    if (legacy && legacy.data && legacy.data.length > 0) buffer = legacy.data;
  }
  if (!buffer) {
    throw new PodFileReadError('File content not found', 404);
  }

  const ct = String(file.contentType || '');
  const isText = isTextualContentType(ct);
  if (isText && buffer.length <= AGENT_FILE_TEXT_MAX) {
    return {
      fileName: file.fileName,
      name: file.originalName,
      contentType: file.contentType,
      size: file.size,
      content: buffer.toString('utf8'),
    };
  }
  return {
    fileName: file.fileName,
    name: file.originalName,
    contentType: file.contentType,
    size: file.size,
    content: null,
    note: isText
      ? `File is ${buffer.length} bytes, over the ${AGENT_FILE_TEXT_MAX}-byte inline text limit.`
      : 'Binary file — content is not returned as text.',
  };
};
