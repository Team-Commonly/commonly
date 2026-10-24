const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const BACKEND = path.resolve(__dirname, '../../..');
const MIGRATION = 'migrate-task-source-ref-identity';
const SKIP = new Set(['node_modules', '__tests__', 'dist', 'coverage', '.git']);

// Static import references only: TypeScript's scanner handles require(),
// import/from, re-exports and literal import() without treating comments or
// prose strings as dependencies. Computed module names are outside this guard.
const migrationImporters = (root) => {
  const found = [];
  const walk = (directory) => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !SKIP.has(entry.name)) walk(file);
      if (!entry.isFile() || !/\.(?:ts|js)$/.test(entry.name)) return;
      const imports = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles;
      imports.forEach(({ fileName }) => {
        if (path.basename(fileName).replace(/\.(?:ts|js)$/, '') === MIGRATION) {
          found.push(`${path.relative(root, file)} -> ${fileName}`);
        }
      });
    });
  };
  walk(root);
  return found.sort();
};

describe('TASK-176: source-ref migration stays outside backend boot imports', () => {
  it('has no non-test backend importer of its process-wide autoIndex side effect', () => {
    expect(fs.existsSync(path.join(BACKEND, 'server.ts'))).toBe(true);
    expect(migrationImporters(BACKEND)).toEqual([]);
  });

  it.each([
    "require('../scripts/migrate-task-source-ref-identity')",
    "require('../scripts/migrate-task-source-ref-identity.ts')",
    "import migration from '../scripts/migrate-task-source-ref-identity'",
    "export * from '../scripts/migrate-task-source-ref-identity'",
    "import('../scripts/migrate-task-source-ref-identity.js')",
  ])('finds a nested production importer: %s', (source) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task176-imports-'));
    try {
      fs.mkdirSync(path.join(root, 'services'));
      fs.writeFileSync(path.join(root, 'services', 'boot.ts'), source);
      // Ignored trees must not contribute false positives.
      SKIP.forEach((directory) => {
        fs.mkdirSync(path.join(root, directory));
        fs.writeFileSync(path.join(root, directory, 'ignored.js'), source);
      });
      fs.writeFileSync(path.join(root, 'comment.js'), `// ${source}\nconst prose = ${JSON.stringify(source)};`);
      const moduleName = ts.preProcessFile(source, true, true).importedFiles[0].fileName;
      expect(migrationImporters(root)).toEqual([`services/boot.ts -> ${moduleName}`]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
