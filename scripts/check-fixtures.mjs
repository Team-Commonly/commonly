#!/usr/bin/env bun
// Validates every fixture in schema/fixtures/<Def>/ against the generated bundle (spec §3 L0 done-test).
// valid-*.json must pass and invalid-*.json must fail. An Envelope fixture's data is also checked
// against the definition its event type names. The Go side of the same check is
// daemon/internal/protocol/fixtures_test.go.
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'gen/ts/schemas.json'), 'utf8'));
const variants = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema/events.json'), 'utf8'))['x-variants'];
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(bundle);
const validator = (def) => ajv.getSchema(`${bundle.$id}#/$defs/${def}`) || fail(`no def ${def}`);
const defName = (ref) => ref.split('/').pop();

function fail(msg) { console.error(msg); process.exit(1); }

const dir = path.join(ROOT, 'schema/fixtures');
let checked = 0;
const problems = [];
for (const def of fs.readdirSync(dir).sort()) {
  const validate = validator(def);
  for (const file of fs.readdirSync(path.join(dir, def)).sort()) {
    const value = JSON.parse(fs.readFileSync(path.join(dir, def, file), 'utf8'));
    let ok = validate(value);
    let errs = validate.errors;
    if (ok && def === 'Envelope') {
      const dataDef = validator(defName(variants[value.type].data));
      ok = dataDef(value.data);
      errs = dataDef.errors;
    }
    const wantValid = file.startsWith('valid-');
    if (!wantValid && !file.startsWith('invalid-')) problems.push(`${def}/${file}: name must start with valid- or invalid-`);
    else if (ok !== wantValid) problems.push(`${def}/${file}: expected ${wantValid ? 'valid' : 'invalid'}${errs ? ` — ${ajv.errorsText(errs)}` : ''}`);
    checked++;
  }
}
if (problems.length) fail(`check-fixtures: ${problems.length} of ${checked} wrong\n  ${problems.join('\n  ')}`);
console.log(`check-fixtures: ${checked} fixtures ok`);
