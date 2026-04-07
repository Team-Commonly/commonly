// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const multer = require('multer');
// eslint-disable-next-line global-require
const File = require('../models/File');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');

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

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req: unknown, file: { originalname: string }, cb: (err: Error | null, accept: boolean) => void) {
    if (!file.originalname.match(/\.(jpg|jpeg|png|gif|webp|svg|JPG|JPEG|PNG|GIF|WEBP|SVG)$/)) {
      return cb(new Error('Only image files are allowed!'), false);
    }
    cb(null, true);
  },
});

const router: ReturnType<typeof express.Router> = express.Router();

router.post('/', auth, upload.single('image'), async (req: AuthReq, res: Res) => {
  try {
    if (!req.file) return res.status(400).json({ msg: 'No file uploaded' });

    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const fileName = `${uniqueSuffix}.${req.file.originalname.split('.').pop()}`;

    const newFile = new File({
      fileName,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
      data: req.file.buffer,
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
    const file = await File.findByFileName(req.params?.fileName);
    if (!file) return res.status(404).json({ msg: 'File not found' });

    res.set('Content-Type', file.contentType);
    res.send(file.data);
  } catch (err) {
    const e = err as { message?: string };
    console.error('Error retrieving file:', e.message);
    res.status(500).json({ msg: 'Server Error' });
  }
});

module.exports = router;
