const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const backendRoot = path.resolve(__dirname, '..');
const jestBin = path.join(backendRoot, 'node_modules', 'jest', 'bin', 'jest.js');
const serviceTest = path.join(backendRoot, '__tests__', 'service', 'slackDmBindingUnique.test.js');
const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'commonly-mongo-cleanup-'));
const nodeBinary = process.env.NODE_BINARY || process.execPath;

const isMongoTempDir = (name) => /^(mongo-mem-|mongodb-memory-server-)/i.test(name);

const directorySize = (target) => {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;

  return fs.readdirSync(target, { withFileTypes: true }).reduce((total, entry) => (
    total + directorySize(path.join(target, entry.name))
  ), 0);
};

const snapshot = () => fs.readdirSync(probeRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && isMongoTempDir(entry.name))
  .map((entry) => {
    const fullPath = path.join(probeRoot, entry.name);
    return { path: fullPath, bytes: directorySize(fullPath) };
  })
  .sort((left, right) => left.path.localeCompare(right.path));

const summarize = (entries) => ({
  count: entries.length,
  bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
});

const before = snapshot();
try {
  for (let run = 1; run <= 2; run += 1) {
    const result = spawnSync(nodeBinary, [jestBin, serviceTest, '--runInBand'], {
      cwd: backendRoot,
      env: { ...process.env, TMPDIR: probeRoot },
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
      break;
    }
    process.stdout.write(`[temp-cleanup] focused service run ${run}/2 passed\n`);
  }

  const after = snapshot();
  const beforePaths = new Set(before.map((entry) => entry.path));
  const leaked = after.filter((entry) => !beforePaths.has(entry.path));
  const beforeSummary = summarize(before);
  const afterSummary = summarize(after);

  process.stdout.write(
    `[temp-cleanup] TMPDIR=${probeRoot} before count=${beforeSummary.count} bytes=${beforeSummary.bytes}; `
    + `after count=${afterSummary.count} bytes=${afterSummary.bytes}\n`,
  );

  if (leaked.length > 0) {
    const paths = leaked.map((entry) => entry.path).join('\n');
    process.stderr.write(`[temp-cleanup] new Mongo temp dirs remain:\n${paths}\n`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(probeRoot, { force: true, recursive: true });
}
