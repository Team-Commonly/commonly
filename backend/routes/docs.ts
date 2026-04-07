import fs from 'fs';
import path from 'path';

// eslint-disable-next-line global-require
const express = require('express');

const router: ReturnType<typeof express.Router> = express.Router();

router.get('/backend', (req: unknown, res: { status: (n: number) => { json: (d: unknown) => void }; type: (t: string) => { send: (d: string) => void } }) => {
  const docPath = path.join(__dirname, '..', 'docs', 'BACKEND.md');
  fs.readFile(docPath, 'utf8', (err: NodeJS.ErrnoException | null, data: string) => {
    if (err) {
      console.error('Error reading backend docs:', err);
      return (res as unknown as { status: (n: number) => { json: (d: unknown) => void } }).status(500).json({ message: 'Unable to load documentation' });
    }
    (res as unknown as { type: (t: string) => { send: (d: string) => void } }).type('text/plain').send(data);
  });
});

module.exports = router;
