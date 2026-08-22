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

/** A bare `main()` / `run()` / async-IIFE at column zero, i.e. at module scope. */
const SELF_EXECUTES = /^\s*(?:main|run)\s*\(\s*\)|^\s*void \(async|^\s*\(async\s*\(\)\s*=>/m;
const GUARDED = /require\.main\s*===\s*module/;

const scriptFiles = () => fs.readdirSync(SCRIPTS)
  .filter((f) => /\.(ts|js)$/.test(f))
  .map((f) => path.join(SCRIPTS, f));

const selfExecutingScripts = () => scriptFiles()
  .filter((full) => {
    const src = fs.readFileSync(full, 'utf8');
    return SELF_EXECUTES.test(src) && !GUARDED.test(src);
  })
  .map((full) => path.basename(full, path.extname(full)));

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
      for (const m of src.matchAll(/(?:require\(|from\s*)['"][^'"]*scripts\/([\w.-]+)['"]/g)) {
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

  test('the backfill that taught us this stays guarded', () => {
    const src = fs.readFileSync(path.join(SCRIPTS, 'backfill-thread-root-id.ts'), 'utf8');
    expect(GUARDED.test(src)).toBe(true);
  });
});
