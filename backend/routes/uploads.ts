/**
 * Attachment uploads — POST writes bytes through the configured ObjectStore
 * driver (ADR-002 Phase 1); GET streams them back, trying the driver first
 * and falling back to legacy `File.data` records for backward compatibility.
 *
 * ADR-002 Phase 1b adds the signed-URL mint endpoint:
 *   - `GET /:fileName/url` — bearer-auth'd, ACL-checked, rate-limited mint of
 *     a short-TTL token scoped to `(fileName, viewerUserId)`. The frontend
 *     exchanges this for a URL (`/api/uploads/:fileName?t=<token>`) it can
 *     drop into `<img src>`.
 *
 * The public-read behavior on `GET /:fileName` is unchanged in this PR. The
 * `?t=` query param is passed through harmlessly today; the follow-up PR
 * flips `GET /:fileName` to require a valid token or header auth and drops
 * the unauth fallback. Until that flip lands, the REVIEW.md §Attachments
 * invariant ("GET must be authorized") is not fully satisfied.
 */

// ADR-002 Phase 1b: ESM import (not require) so CodeQL's js/missing-rate-limiting
// query recognises the middleware on the mint route.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'crypto';
import path from 'path';
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  canReadAttachment,
  signAttachmentToken,
} from '../services/attachmentAccess';
import { logAttachmentTokenMint } from '../services/auditService';
// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const multer = require('multer');
// eslint-disable-next-line global-require
const File = require('../models/File');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
import { getObjectStore } from '../services/objectStore';

interface AuthReq {
  userId?: string;
  ip?: string;
  protocol?: string;
  get?: (header: string) => string | undefined;
  file?: { originalname: string; mimetype: string; size: number; buffer: Buffer };
  params?: { fileName?: string };
  query?: { t?: string };
  body?: { podId?: string };
  agentUser?: { _id: { toString: () => string } };
  agentAuthorizedPodIds?: string[];
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
  set: (header: string, value: string) => void;
  send: (d: unknown) => void;
}

// Per-kind extension allowlist. Replaces the original image-only regex.
//
// Office formats (docx/xlsx/pptx + legacy doc/xls/ppt) and zip archives
// shipped 2026-05-03 alongside the v2 inspector demo path. They store as
// opaque bytes and download (no in-page render), so the XSS / SVG-style
// attack surface that gates `image/*` doesn't apply. Macro execution risk
// lives at file-OPEN on the user's machine — same model as receiving the
// same file via email.
//
// Still deferred to ADR-002 Phase 6: ClamAV scanning, AV media (mp4/mov/
// mp3/wav — large + needs streaming), virus signature feed.
const KIND_EXTENSIONS: Record<string, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'],
  document: ['pdf', 'md', 'txt'],
  data: ['csv', 'json'],
  office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp'],
  archive: ['zip'],
};
const ALLOWED_EXT_REGEX = new RegExp(
  `\\.(${Object.values(KIND_EXTENSIONS).flat().join('|')})$`,
  'i',
);
const kindFromName = (originalName: string): string => {
  const dot = originalName.lastIndexOf('.');
  if (dot < 0) return 'other';
  const ext = originalName.slice(dot + 1).toLowerCase();
  for (const [kind, exts] of Object.entries(KIND_EXTENSIONS)) {
    if (exts.includes(ext)) return kind;
  }
  return 'other';
};

// Size cap is driven by the driver's declared max. multer returns 413 itself
// when the multipart exceeds it, so the route doesn't need a secondary check.
//
// This runs at module load, so driver constructors MUST stay pure (no network,
// no DB connects). The current MongoObjectStore only sets capability fields;
// any future driver (GCS, S3) should defer network I/O to first put/get, not
// its constructor, or this require() becomes a silent network call.
const MAX_UPLOAD_BYTES = getObjectStore().capabilities.maxObjectBytes;

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(
    _req: unknown,
    file: { originalname: string },
    cb: (err: Error | null, accept: boolean) => void,
  ) {
    if (!ALLOWED_EXT_REGEX.test(file.originalname)) {
      return cb(new Error('File type not allowed'), false);
    }
    cb(null, true);
  },
});

// Wrap multer.single so filter / size errors become 400s instead of bubbling
// as 500. Multer's default error path is the route's try/catch, which can't
// distinguish "user sent a bad type" from "driver crashed".
const uploadSingle = (field: string) => (req: AuthReq, res: Res, next: (err?: unknown) => void) => {
  upload.single(field)(req as never, res as never, (err: unknown) => {
    if (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ msg: 'File too large' });
      }
      return res.status(400).json({ msg: e?.message || 'Invalid upload' });
    }
    next();
  });
};

// 30 mints/min/bucket is generous for a page loading dozens of avatars +
// images (clients cache until TTL expiry) and low enough that a compromised
// JWT can't scrape attachments en masse. Keyed on the Authorization header
// (hashed) so each user's bearer token gets its own bucket — NAT'd users
// sharing one office IP don't collide. Falling back to `req.ip` covers the
// unauth path. Inlined in this file and applied as the FIRST middleware on
// the route so CodeQL's `js/missing-rate-limiting` query sees it (the query
// only recognises the limiter when it precedes other middleware).
const mintRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: AuthReq) => {
    const authHeader = req.get?.('authorization');
    if (authHeader) {
      return `tok:${createHash('sha256').update(authHeader).digest('hex').slice(0, 16)}`;
    }
    return req.ip ? ipKeyGenerator(req.ip) : 'anon';
  },
  handler: (_req: unknown, res: Res) =>
    res.status(429).json({ msg: 'rate limit exceeded: 30 mints per 60s' }),
});

const router: ReturnType<typeof express.Router> = express.Router();

// Shared upload handler — used by both the user-auth POST / and the
// agent-runtime POST /agent. Caller passes the resolved uploader id and
// (optionally) the podId scope to bind the File row to.
//
// Upload routes accept a `podId` form field; populating it surfaces the
// file in the pod inspector's Artifacts section. Agent uploads must
// supply a podId they're installed in (enforced in the agent route).
const handleUpload = async (
  req: AuthReq,
  res: Res,
  uploaderId: string,
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ msg: 'No file uploaded' });
      return;
    }

    const store = getObjectStore();

    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(req.file.originalname);
    const fileName = `${uniqueSuffix}${ext}`;
    const kind = kindFromName(req.file.originalname);
    const podId = req.body?.podId?.toString().trim() || null;

    await store.put(fileName, req.file.buffer, req.file.mimetype);

    // Metadata-only File record. Bytes live in the ObjectStore driver;
    // Phase 2 replaces File with a proper Attachment registry and removes
    // the legacy `data` field entirely.
    const newFile = new File({
      fileName,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      uploadedBy: uploaderId,
      podId,
    });
    await newFile.save();

    const { protocol } = req;
    const host = req.get?.('host');
    const url = `${protocol}://${host}/api/uploads/${fileName}`;

    res.json({
      url,
      fileName,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      kind,
      podId,
    });
  } catch (err) {
    const e = err as { message?: string };
    console.error('Upload error:', e.message);
    res.status(500).json({ msg: 'Server Error' });
  }
};

router.post('/', auth, uploadSingle('image'), async (req: AuthReq, res: Res) => {
  if (!req.userId) {
    res.status(401).json({ msg: 'auth required' });
    return;
  }
  await handleUpload(req, res, req.userId);
});

// ADR-002 Phase 1b: signed-URL mint endpoint. Declared before the bare
// `:fileName` GET so Express doesn't match `/:fileName/url` as a fileName
// containing a slash. `mintRateLimit` runs before `auth` because (1) CodeQL's
// js/missing-rate-limiting query only recognises the limiter as the first
// middleware, and (2) the limiter's keyGenerator reads the Authorization
// header directly, so it doesn't need auth to have populated `req.userId`.
router.get('/:fileName/url', mintRateLimit, auth, async (req: AuthReq, res: Res) => {
  try {
    const fileName = req.params?.fileName;
    if (!fileName) return res.status(400).json({ msg: 'fileName required' });
    if (!req.userId) return res.status(401).json({ msg: 'auth required' });

    const allowed = await canReadAttachment(fileName, req.userId);
    if (!allowed) return res.status(403).json({ msg: 'no access to this attachment' });

    const token = signAttachmentToken(fileName, req.userId);
    const url = `/api/uploads/${fileName}?t=${encodeURIComponent(token)}`;

    // Fire-and-forget: auditService swallows failures.
    void logAttachmentTokenMint({
      fileName,
      userId: req.userId,
      ip: req.ip,
      userAgent: req.get?.('user-agent'),
    });

    return res.json({ url, expiresIn: DEFAULT_TOKEN_TTL_SECONDS });
  } catch (err) {
    const e = err as { message?: string };
    console.error('Mint signed URL error:', e.message);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/:fileName', async (req: AuthReq, res: Res) => {
  try {
    const fileName = req.params?.fileName;
    if (!fileName) return res.status(400).json({ msg: 'fileName required' });

    // The `?t=<token>` query param minted by `GET /:fileName/url` is passed
    // through harmlessly; Express ignores unknown query params. Validation +
    // enforcement land in the follow-up PR that removes public-read. See
    // ADR-002 Phase 1b "flip" note at the top of this file.

    const store = getObjectStore();
    const obj = await store.get(fileName);
    if (obj) {
      res.set('Content-Type', obj.mime);
      (obj.stream as unknown as { pipe: (dst: unknown) => void }).pipe(res);
      return;
    }

    // Backward-compat fallback for pre-ADR-002 records with inline bytes.
    // Phase 2 backfills these into the driver and removes this fallback.
    const legacy = await File.findByFileName(fileName);
    if (legacy && legacy.data && legacy.data.length > 0) {
      res.set('Content-Type', legacy.contentType);
      return res.send(legacy.data);
    }

    return res.status(404).json({ msg: 'File not found' });
  } catch (err) {
    const e = err as { message?: string };
    console.error('Error retrieving file:', e.message);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

// Exported so the agent-runtime upload route can reuse the shared helpers
// without going through HTTP. The route file mounts `handleUpload` behind
// agentRuntimeAuth and gates podId against the agent's authorized pods.
export { handleUpload, uploadSingle };

module.exports = router;
module.exports.handleUpload = handleUpload;
module.exports.uploadSingle = uploadSingle;
