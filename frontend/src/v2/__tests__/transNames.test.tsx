// @ts-nocheck
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render } from '@testing-library/react';
import { Trans } from 'react-i18next';
import { i18nReady } from '../../i18n';

const SRC = path.resolve(__dirname, '../..');

const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(full);
  return /\.tsx?$/.test(entry.name) ? [full] : [];
});

// Names go in as component children; `values` holds only what the app produces itself.
const OWN_VALUES = new Set(['count', 'notes', 'time', 'path']);

// The text of each <Trans ...> opening tag, ending at the first > outside braces and quotes.
const openingTags = (source) => [...source.matchAll(/<Trans\b/g)].map((match) => {
  let depth = 0;
  let quote = null;
  for (let i = match.index; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (/['"`]/.test(ch)) quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(match.index, i + 1);
  }
  return source.slice(match.index);
});

// The entries of an object literal, split at its top-level commas.
const entries = (body) => {
  const out = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (/['"`]/.test(ch)) quote = ch;
    else if (/[{([]/.test(ch)) depth += 1;
    else if (/[})\]]/.test(ch)) depth -= 1;
    if (ch === ',' && depth === 0 && !quote) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  return [...out, current].map((entry) => entry.trim()).filter(Boolean);
};

const problems = (tag) => {
  const found = [];
  if (!/\bi18nKey=/.test(tag)) found.push('no i18nKey');
  if (/\b(tOptions|defaults)=/.test(tag)) found.push('tOptions or defaults');
  if (!tag.endsWith('/>')) found.push('has children');
  if (/\s\{\.\.\./.test(tag)) found.push('spread props');
  const at = tag.search(/\bvalues=/);
  if (at === -1) return found;
  const literal = /^values=\{\{/.test(tag.slice(at));
  if (!literal) return [...found, 'values is not a literal'];
  let depth = 0;
  let end = at + 'values='.length;
  for (let i = end; i < tag.length; i += 1) {
    if (tag[i] === '{') depth += 1;
    if (tag[i] === '}') depth -= 1;
    if (depth === 0) { end = i; break; }
  }
  const body = tag.slice(at + 'values={{'.length, end - 1);
  for (const entry of entries(body)) {
    const key = entry.match(/^(\w+)\s*(?::|$)/)?.[1];
    if (!key || !OWN_VALUES.has(key)) found.push(entry.slice(0, 40));
  }
  return found;
};

test('every Trans in the app passes only what the app produced itself', () => {
  const tags = sources(SRC).flatMap((file) => openingTags(fs.readFileSync(file, 'utf8')));
  expect(tags.length).toBeGreaterThan(5);
  expect(tags.flatMap(problems)).toEqual([]);
});

test.each([
  ['<Trans i18nKey="a" values={{ pod: x }} />'],
  ['<Trans i18nKey="a" components={{ b: <b /> }} values={{ pod: x }} />'],
  ['<Trans i18nKey={(k) => k} values={{ pod: x }} />'],
  ['<Trans i18nKey="a" values={{ count, pod }} />'],
  ['<Trans i18nKey="a" values={names} />'],
  ['<Trans i18nKey="a" values={{ ...names }} />'],
  ['<Trans i18nKey="a" values={{ \'pod\': x }} />'],
  ['<Trans i18nKey="a" tOptions={{ pod: x }} />'],
  ['<Trans i18nKey="a" defaults="x" />'],
  ['<Trans>'],
  ['<Trans i18nKey="a">'],
  ['<Trans i18nKey="a" {...props} />'],
])('the check refuses %s', (source) => {
  expect(openingTags(source).flatMap(problems)).not.toEqual([]);
});

test.each([
  ['<Trans i18nKey="a" components={{ b: <b>{x}</b> }} />'],
  ['<Trans i18nKey="a" values={{ count: list.length, time: age(a, { b: 1 }) }} components={{ b: <b /> }} />'],
])('the check allows %s', (source) => {
  expect(openingTags(source).flatMap(problems)).toEqual([]);
});

beforeAll(async () => { await i18nReady; });

// As component children, all of these stay literal. Through `values`, a tag named in `components`
// with a `style` attribute makes React throw, and a template would be filled in a second time.
test.each([
  ['Growth pod'],
  ['Ops & Design'],
  ['<pod style="color:red">x</pod>'],
  ['{{username}}'],
])('a grant line shows a pod name exactly: %s', (name) => {
  const { container } = render(
    <Trans i18nKey="tools.grantedToPodBy" components={{ pod: <b>{name}</b>, member: <b>sam</b> }} />,
  );
  expect(container.textContent).toBe(`granted to ${name} by sam`);
  expect(container.querySelectorAll('b')).toHaveLength(2);
});
