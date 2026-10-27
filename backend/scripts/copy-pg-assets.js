const fs = require('fs');
const path = require('path');

// tsc emits JavaScript only. Keep source and built boot paths equivalent.
const config = path.join(__dirname, '../config');
const output = path.join(__dirname, '../dist/config');
fs.mkdirSync(output, { recursive: true });
fs.rmSync(path.join(output, 'migrations'), { recursive: true, force: true });
fs.cpSync(path.join(config, 'migrations'), path.join(output, 'migrations'), { recursive: true });
fs.copyFileSync(path.join(config, 'schema.sql'), path.join(output, 'schema.sql'));
