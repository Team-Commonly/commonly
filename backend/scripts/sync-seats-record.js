/**
 * Copy the shared record-v1 writer from packages/seats into backend/vendor,
 * byte for byte. The backend image is built from backend/ alone, so it cannot
 * reach packages/seats at runtime; this keeps one implementation in two
 * places, and __tests__/unit/vendor/seatsRecordVendor.test.js fails when they
 * differ. Edit packages/seats, then run `npm run sync:seats-record`.
 */
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '../../packages/seats');
const TARGET = path.join(__dirname, '../vendor/seats');
// format.js and otel.js plus everything they import, relative to the package.
const FILES = [
  'src/failures.js',
  'src/harness-plan.js',
  'src/upstream-refusal.js',
  'src/record/format.js',
  'src/record/otel.js',
];

if (require.main === module) {
  FILES.forEach((file) => {
    fs.mkdirSync(path.dirname(path.join(TARGET, file)), { recursive: true });
    fs.copyFileSync(path.join(SOURCE, file), path.join(TARGET, file));
  });
  console.log(`synced ${FILES.length} files into ${path.relative(process.cwd(), TARGET)}`);
}

module.exports = { SOURCE, TARGET, FILES };
