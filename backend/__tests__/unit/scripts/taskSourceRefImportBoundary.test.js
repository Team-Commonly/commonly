const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const BACKEND = path.resolve(__dirname, '../../..');
const MIGRATION = 'migrate-task-source-ref-identity';
const SKIP = new Set(['node_modules', '__tests__', 'dist', 'coverage', '.git']);

// Static references only. preProcessFile misses namespace re-exports, so
// inspect syntax nodes; never evaluate a backend module to discover imports.
// Explicit type-only import/export declarations do not execute the migration.
const moduleReferences = (source) => {
  const references = [];
  const hasRuntimeImport = (clause) => clause?.name
    || !clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)
    || clause.namedBindings.elements.length === 0
    || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
  const hasRuntimeExport = (clause) => !clause || !ts.isNamedExports(clause)
    || clause.elements.length === 0
    || clause.elements.some((element) => !element.isTypeOnly);
  const staticText = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
  const tree = ts.createSourceFile('boundary.ts', source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly
      && hasRuntimeImport(node.importClause))
      || (ts.isExportDeclaration(node) && !node.isTypeOnly
        && hasRuntimeExport(node.exportClause))) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        references.push(node.moduleSpecifier.text);
      }
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      references.push(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node)
      && ((ts.isIdentifier(node.expression) && node.expression.text === 'require')
        || node.expression.kind === ts.SyntaxKind.ImportKeyword)
      && node.arguments[0] && staticText(node.arguments[0])) {
      references.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return references;
};

const migrationImporters = (root) => {
  const found = [];
  const walk = (directory) => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !SKIP.has(entry.name)) walk(file);
      if (!entry.isFile() || !/\.(?:ts|js)$/.test(entry.name)) return;
      const imports = moduleReferences(fs.readFileSync(file, 'utf8'));
      imports.forEach((fileName) => {
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

  it('ignores explicit type-only imports and re-exports', () => {
    expect(moduleReferences(`
      import type Migration from '../scripts/migrate-task-source-ref-identity';
      import { type Migration } from '../scripts/migrate-task-source-ref-identity';
      export type * as Migration from '../scripts/migrate-task-source-ref-identity';
      export type { Migration } from '../scripts/migrate-task-source-ref-identity';
      export { type Migration } from '../scripts/migrate-task-source-ref-identity';
    `)).toEqual([]);
  });

  it.each([
    'require(`../scripts/migrate-task-source-ref-identity`)',
    'import(`../scripts/migrate-task-source-ref-identity`)',
    "import { type Migration, migrate } from '../scripts/migrate-task-source-ref-identity'",
    "export { type Migration, migrate } from '../scripts/migrate-task-source-ref-identity'",
    "require('../scripts/migrate-task-source-ref-identity')",
    "require('../scripts/migrate-task-source-ref-identity.ts')",
    "import migration from '../scripts/migrate-task-source-ref-identity'",
    "import migration = require('../scripts/migrate-task-source-ref-identity')",
    "export * as migration from '../scripts/migrate-task-source-ref-identity'",
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
      const moduleName = /['"`]([^'"`]+)['"`]/.exec(source)[1];
      expect(migrationImporters(root)).toEqual([`services/boot.ts -> ${moduleName}`]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
