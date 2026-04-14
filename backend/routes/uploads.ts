/**
 * Attachment uploads — POST writes bytes through the configured ObjectStore
 * driver (ADR-002 Phase 1); GET streams them back, trying the driver first
 * and falling back to legacy `File.data` records for backward compatibility.
 *
 * Phase 1 intentionally does not close the pre-existing authorization gap on
 * GET: adding `auth` middleware here would break every `<img src>` across
 * the app, since browsers cannot attach JWTs to plain image requests. The
 * proper fix (signed short-TTL tokens in the URL, minted per-viewer after a
 * pod/post ACL check) lands in Phase 1b alongside the frontend changes that
 * rewrite upload URLs at render time. The gap is cited as a Critical in
 * REVIEW.md §Attachments (ADR-002) — do not approve Phase 1 to production
 * without Phase 1b.
 */

import path from 'path';
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
  protocol?: string;
  get?: (header: string) => string | undefined;
  file?: { originalname: string; mimetype: string; size: number; buffer: Buffer };
  params?: { fileName?: string };
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
  set: (header: string, value: string) => void;
  send: (d: unknown) => void;
}

const ALLOWED_EXT_REGEX = /\.(jpg|jpeg|png|gif|webp|svg)$/i;

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
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  },
});

const router: ReturnType<typeof express.Router> = express.Router();

router.post('/', auth, upload.single('image'), async (req: AuthReq, res: Res) => {
  try {
    if (!req.file) return res.status(400).json({ msg: 'No file uploaded' });

    const store = getObjectStore();

    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(req.file.originalname);
    const fileName = `${uniqueSuffix}${ext}`;

    await store.put(fileName, req.file.buffer, req.file.mimetype);

    // Metadata-only File record. Bytes live in the ObjectStore driver;
    // Phase 2 replaces File with a proper Attachment registry and removes
    // the legacy `data` field entirely.
    const newFile = new File({
      fileName,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.userId,
    });
    await newFile.save();

    const { protocol } = req;
    const host = req.get?.('host');
    const url = `${protocol}://${host}/api/uploads/${fileName}`;

    return res.json({ url, fileName, contentType: req.file.mimetype, size: req.file.size });
  } catch (err) {
    const e = err as { message?: string };
    console.error('Upload error:', e.message);
    return res.status(500).json({ msg: 'Server Error' });
  }
});

router.get('/:fileName', async (req: AuthReq, res: Res) => {
  try {
    const fileName = req.params?.fileName;
    if (!fileName) return res.status(400).json({ msg: 'fileName required' });

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

module.exports = router;

export {};
