/**
 * test/vectors/args-digest.json is the contract a writer in another language
 * passes to produce the same argsDigest as argsDigestOf. This test holds the
 * vectors to the code, so neither can change without the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argsDigestOf } from '../src/record/format.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'vectors', 'args-digest.json');
const { _about: about, vectors } = JSON.parse(readFileSync(FILE, 'utf8'));

/** The file's two tags: {"$undefined":true} and {"$number":"<literal>"}, each an object with one key. */
const decode = (value) => {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$undefined' && value.$undefined === true) return undefined;
  if (keys.length === 1 && keys[0] === '$number' && typeof value.$number === 'string') return Number(value.$number);
  return Object.fromEntries(keys.map((key) => [key, decode(value[key])]));
};

test('the vector file documents its tags and covers what writers get wrong', () => {
  assert.match(about, /\$undefined/);
  assert.match(about, /\$number/);
  const names = new Set(vectors.map((v) => v.name));
  assert.equal(names.size, vectors.length, 'vector names are distinct');
  for (const v of vectors) {
    assert.equal(typeof v.name, 'string');
    assert.ok('args' in v, `${v.name} has args`);
    if (v.error === true) {
      assert.deepEqual(Object.keys(v).sort(), ['args', 'error', 'name'], `${v.name}: an error vector has no digest`);
    } else {
      assert.match(v.digest, /^sha256:[0-9a-f]{64}$/, v.name);
      assert.equal(typeof v.canonical, 'string', v.name);
    }
  }
  const raw = JSON.stringify(vectors);
  for (const tag of ['{"$undefined":true}', '{"$number":"NaN"}', '{"$number":"-0"}', '{"$number":"1e21"}', '{"$number":"1.0"}']) {
    assert.ok(raw.includes(tag), `a vector uses ${tag}`);
  }
  assert.ok(vectors.filter((v) => v.error).length >= 3, 'non-finite and undefined inputs are covered');
});

for (const v of vectors) {
  test(`args digest vector: ${v.name}`, () => {
    const got = argsDigestOf(decode(v.args));
    if (v.error === true) {
      assert.equal(got, undefined, 'no digest: a writer omits argsDigest');
      return;
    }
    assert.equal(v.digest, `sha256:${createHash('sha256').update(v.canonical, 'utf8').digest('hex')}`, 'digest is sha256 of canonical');
    assert.equal(got, v.digest);
  });
}
