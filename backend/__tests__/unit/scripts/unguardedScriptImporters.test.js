/**
 * Importing a module must not RUN it.
 *
 * The threading backfill executed `main()` at module scope. A controller
 * imported one constant from it, server.ts reached that controller on the
 * boot path, and so booting the server ran a data migration. Nothing failed
 * loudly: the migration is idempotent, so the only symptom was work happening
 * at a time nobody chose.
 *
 * @sprint-review swept for other live instances and found none — the only
 * script imported by non-script code is seed-native-agents, which declares
 * exports and never calls anything at module scope. That sweep is correct and
 * this test does not repeat it.
 *
 * What it adds is the other half. "No live instances" is a statement about
 * today's importers, not about the scripts: at the time of writing, 14 files
 * under scripts/ invoke `main()` (or an async IIFE) at module scope with no
 * `require.main === module` guard. Every one is safe purely because nothing
 * requires it yet, and the backfill was in exactly that state until somebody
 * wanted one constant out of it. The importer is the variable, and importers
 * get added casually.
 *
 * So the rule enforced here is the harm condition itself rather than a style
 * preference: a script may self-execute, and a module may import a script,
 * but not both at once. Deliberate invocations stay legal — server.ts calls
 * `seedNativeAgents()` on purpose, and that is a call, not an import
 * side effect.
 */

const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '../../..');
const SCRIPTS = path.join(BACKEND, 'scripts');

/**
 * A bare `main()` / `run()` / async-IIFE at COLUMN ZERO.
 *
 * @sprint-review (57328): the previous comment said column zero and the regex
 * said `^\s*`, which also matches an indented `main()` inside a function body.
 * That over-flags in the safe direction, so nothing broke — but a false
 * positive here points someone at a file that is fine, and the honest way to
 * make the test pass again is to weaken it. Anchored properly; the control
 * below proves an indented call is not counted.
 */
const SELF_EXECUTES = /^(?:main|run)\s*\(\s*\)|^void \(async|^\(async\s*\(\)\s*=>/m;
const GUARDED = /require\.main\s*===\s*module/;

/**
 * An import of something under scripts/, capturing the path BELOW it.
 *
 * `[\w./-]+` rather than `[\w.-]+`: the capture has to cross slashes, or
 * `scripts/sub/foo` reads as an import of nothing at all. Defined once and
 * used by both the scan and its control — a control that retypes the pattern
 * is testing the copy, which is the same mistake as asserting a claim by
 * grepping for the string that makes it.
 */
const IMPORT_OF_SCRIPT = /(?:require\(|from\s*)['"][^'"]*scripts\/([\w./-]+)['"]/g;

/**
 * Every script, RECURSIVELY, keyed by its path under scripts/ without the
 * extension — `sub/foo`, not `foo`.
 *
 * @sprint-review (57329): `readdirSync` is not recursive and the importer
 * pattern stopped its capture at the first slash, so a script in a
 * subdirectory was invisible to both halves at once — and both controls would
 * still have passed while it went unscanned. `backend/scripts` is flat today,
 * which is exactly what makes that the kind of gap nobody notices: the guard
 * would keep reporting success on the day the first subdirectory appeared.
 */
const scriptFiles = (dir = SCRIPTS) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return scriptFiles(full);
    return /\.(ts|js)$/.test(entry.name) ? [full] : [];
  });

const keyOf = (full) => path
  .relative(SCRIPTS, full)
  .replace(/\.(ts|js)$/, '')
  .split(path.sep)
  .join('/');

const selfExecutingScripts = () => scriptFiles()
  .filter((full) => {
    const src = fs.readFileSync(full, 'utf8');
    return SELF_EXECUTES.test(src) && !GUARDED.test(src);
  })
  .map(keyOf);

/** Production modules outside scripts/ that `require`/`import` from scripts/. */
const importersOfScripts = () => {
  const found = [];
  const skip = new Set(['node_modules', '__tests__', 'dist', 'coverage', '.git', 'scripts']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
        continue;
      }
      if (!/\.(ts|js)$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(new RegExp(IMPORT_OF_SCRIPT.source, 'g'))) {
        found.push({ importer: path.relative(BACKEND, full), script: m[1] });
      }
    }
  };
  walk(BACKEND);
  return found;
};

describe('a script that self-executes must not be importable', () => {
  test('no production module imports a script that runs at module scope', () => {
    const unguarded = new Set(selfExecutingScripts());
    const offenders = importersOfScripts()
      .filter(({ script }) => unguarded.has(script))
      .map(({ importer, script }) => `${importer} -> scripts/${script}`);

    // Named rather than counted: the message has to say which pair, because
    // the fix is either "guard the script" or "move the shared value out of
    // it", and which one depends on the pair.
    expect(offenders).toEqual([]);
  });

  test('CONTROL: the detector finds the self-executing scripts it is meant to', () => {
    // Without this, a regex that silently matched nothing would make the test
    // above pass forever. That is the failure mode the whole file is about,
    // so the instrument gets the same treatment as the thing it measures.
    expect(selfExecutingScripts().length).toBeGreaterThan(0);
  });

  test('CONTROL: the importer scan finds the known live importers', () => {
    // seed-native-agents is imported by authController and personaHireService
    // and is safe because it only exports. If this goes empty the scan broke.
    const scripts = importersOfScripts().map((e) => e.script);
    expect(scripts).toContain('seed-native-agents');
  });

  test('CONTROL: an indented call inside a function body is NOT module scope', () => {
    // The blind spot @sprint-review found. `^\\s*` matched this, which means
    // the detector called an ordinary helper a self-executing script.
    expect(SELF_EXECUTES.test('function f() {\n  main();\n}\n')).toBe(false);
    expect(SELF_EXECUTES.test('if (x) {\n  run();\n}\n')).toBe(false);
    // ...while the real thing still trips it, or the fix would be a mute.
    expect(SELF_EXECUTES.test('main();\n')).toBe(true);
    expect(SELF_EXECUTES.test('void (async () => {})();\n')).toBe(true);
  });

  describe('CONTROL: a script in a subdirectory is visible to both halves', () => {
    const SUB = path.join(SCRIPTS, '__probe_sub');
    const FILE = path.join(SUB, 'nested.ts');

    beforeEach(() => {
      fs.mkdirSync(SUB, { recursive: true });
      fs.writeFileSync(FILE, 'export const f = () => 1;\nmain();\n');
    });

    afterEach(() => {
      fs.rmSync(SUB, { recursive: true, force: true });
      // Asserted, not assumed. A cleanup that silently does nothing is how a
      // probe leaves the tree dirty and the next run lies about why.
      expect(fs.existsSync(SUB)).toBe(false);
    });

    test('the walk reaches it and keys it by subpath', () => {
      expect(selfExecutingScripts()).toContain('__probe_sub/nested');
    });

    test('and an importer of it is matched across the slash', () => {
      const line = "require('../scripts/__probe_sub/nested')";
      const m = [...line.matchAll(new RegExp(IMPORT_OF_SCRIPT.source, 'g'))];
      expect(m.map((x) => x[1])).toEqual(['__probe_sub/nested']);
    });
  });

  test('the backfill that taught us this stays guarded', () => {
    const src = fs.readFileSync(path.join(SCRIPTS, 'backfill-thread-root-id.ts'), 'utf8');
    expect(GUARDED.test(src)).toBe(true);
  });
});
