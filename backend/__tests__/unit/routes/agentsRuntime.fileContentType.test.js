/**
 * The pod-file read must not hand an agent raw binary labelled `content`.
 *
 * The classifier was
 *   /^text\/|json|csv|xml|javascript|markdown|yaml|x-sh|html/
 * in which ONLY `^text/` is anchored — every alternative after it matched
 * anywhere in the header. `application/vnd.openXMLformats-officedocument.
 * wordprocessingml.document` contains "xml", so every OOXML file was
 * classified as text and returned as ZIP bytes decoded as UTF-8, in
 * `content`, with no `note`.
 *
 * Measured against the live instance 2026-08-05: a 939-byte .docx with one
 * text run came back as `"PK…"`. A PDF was never affected
 * (`application/pdf` matches nothing in that pattern) and correctly returned
 * `content: null` + the binary note — which is why this survived: the format
 * people tested failed honestly, and the one that didn't was never tested.
 *
 * These mount the REAL router, because the bug is in the route's own
 * classification step. A test of an exported predicate would pass even if
 * the route stopped calling it.
 */

// Local Node-26 drift: jsonwebtoken's transitive buffer-equal-constant-time
// throws on import. CI (Node 20) is unaffected.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  req.agentInstallations = [{ podId: 'pod-1', status: 'active' }];
  req.agentAuthorizedPodIds = ['pod-1'];
  next();
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({ buildAgentUsername: jest.fn((a) => a) }));
jest.mock('../../../services/agentMessageService', () => ({ getRecentMessages: jest.fn() }));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));
jest.mock('../../../models/File', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findByFileName: jest.fn(),
}));
// uploads.ts calls getObjectStore() at MODULE LOAD to read
// capabilities.maxObjectBytes, so the default return must be shaped —
// a bare jest.fn() makes the whole router fail to import.
jest.mock('../../../services/objectStore', () => ({
  getObjectStore: jest.fn(() => ({
    capabilities: { maxObjectBytes: 25 * 1024 * 1024 },
    get: jest.fn(),
  })),
}));

const express = require('express');
const request = require('supertest');
const { Readable } = require('stream');

const File = require('../../../models/File');
const { getObjectStore } = require('../../../services/objectStore');
const router = require('../../../routes/agentsRuntime');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

// A real ZIP local-file-header magic, so the fixture is genuinely binary
// rather than text that merely claims a binary content type.
const ZIP_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xbd, 0xd3]),
]);

const serveFile = ({ contentType, bytes, name = 'f' }) => {
  // The route chains .select().lean() — a mock missing .select() throws
  // inside the handler's try and surfaces as an opaque 500, which looks
  // like a route bug rather than a test bug.
  File.findOne.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({
      fileName: 'stored-name.bin', originalName: name, contentType, size: bytes.length,
    }),
  });
  getObjectStore.mockReturnValue({
    capabilities: { maxObjectBytes: 25 * 1024 * 1024 },
    get: jest.fn().mockResolvedValue({ stream: Readable.from([bytes]) }),
  });
};

const read = () => request(app).get('/api/agents/runtime/pods/pod-1/files/stored-name.bin/content');

const OOXML = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

describe('pod file read — content type classification', () => {
  beforeEach(() => jest.clearAllMocks());

  // THE regression guard. Every one of these content types contains the
  // literal substring "xml" inside "openxmlformats", which is exactly how
  // they defeated the old pattern.
  describe.each(Object.entries(OOXML))('%s', (ext, contentType) => {
    test('is not classified as text — no raw bytes in `content`', async () => {
      serveFile({ contentType, bytes: ZIP_BYTES, name: `doc.${ext}` });
      const res = await read();

      expect(res.status).toBe(200);
      expect(res.body.content).toBeNull();
      // The agent must be TOLD, not just given null — silence and a note
      // are different failures from the reader's side.
      expect(res.body.note).toMatch(/binary/i);
      // Belt and braces: the ZIP magic must not appear anywhere in the
      // response, however it might be re-encoded.
      expect(JSON.stringify(res.body)).not.toContain('PK');
    });
  });

  // The control. Without this, a classifier that returns false for
  // everything would pass every assertion above.
  test('plain text still comes back as content', async () => {
    serveFile({ contentType: 'text/plain', bytes: Buffer.from('TXT_SENTINEL_GAMMA\n'), name: 'a.txt' });
    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('TXT_SENTINEL_GAMMA\n');
    expect(res.body.note).toBeUndefined();
  });

  // The alternatives the old pattern was actually written for must keep
  // working — the fix narrows the match, and narrowing is how you break
  // the legitimate cases while fixing the illegitimate one.
  test.each([
    ['application/json', '{"a":1}'],
    ['application/xml', '<a/>'],
    ['text/csv', 'a,b\n1,2'],
    ['application/javascript', 'const a=1;'],
    ['text/markdown', '# hi'],
    ['application/x-yaml', 'a: 1'],
    ['application/x-sh', 'echo hi'],
    ['text/html', '<p>hi</p>'],
    // Structured syntax suffixes — the reason the rule is "+xml at the END
    // of the subtype" rather than "contains xml".
    ['image/svg+xml', '<svg/>'],
    ['application/ld+json', '{"@id":"x"}'],
    // Parameters must not defeat the parse.
    ['text/plain; charset=utf-8', 'hi'],
  ])('%s is still treated as text', async (contentType, body) => {
    serveFile({ contentType, bytes: Buffer.from(body) });
    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.content).toBe(body);
  });

  // PDF was correct before and must stay correct — it is the format whose
  // honest failure hid the OOXML case for as long as it did.
  test('pdf still refuses honestly, with a note', async () => {
    serveFile({ contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n'), name: 'a.pdf' });
    const res = await read();

    expect(res.status).toBe(200);
    expect(res.body.content).toBeNull();
    expect(res.body.note).toMatch(/binary/i);
  });

  // An empty/absent content type must not fall through to "text".
  test.each([[''], [undefined], ['application/octet-stream']])(
    'contentType %p is not text',
    async (contentType) => {
      serveFile({ contentType, bytes: ZIP_BYTES });
      const res = await read();

      expect(res.status).toBe(200);
      expect(res.body.content).toBeNull();
    },
  );
});
