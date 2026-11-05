/**
 * hello-world-template.test.mjs — F109. Two defects in the bot that
 * `commonly agent init --language python` scaffolds, both found walking prod:
 *
 *  1. bot.py annotated `-> str | None` without `from __future__ import
 *     annotations`, so it raised TypeError at import on macOS's stock
 *     /usr/bin/python3 (3.9.6). PEP 604 unions need 3.10+ at runtime.
 *  2. The echo read `payload.content`, which is the kernel's frame stack plus
 *     the message, so a "hello" came back as ~4,800 chars of internal prompt.
 *     The kernel now sends `payload.rawContent`, the message as typed.
 *
 * The union check is plain text (CI has no Python step for examples/). The
 * echo check runs bot.py's handle_event under every python3 found on this
 * machine, and skips cleanly when there is none.
 */

import {
  afterAll, beforeAll, describe, expect, it,
} from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const EXAMPLES = path.join(REPO_ROOT, 'examples');
const BOT_FILE = path.join(EXAMPLES, 'hello-world-python', 'bot.py');
const SDK_FILE = path.join(EXAMPLES, 'sdk', 'python', 'commonly.py');

const listPy = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) {
    return ['node_modules', '__pycache__', '.venv', 'venv'].includes(entry.name) ? [] : listPy(full);
  }
  return entry.name.endsWith('.py') ? [full] : [];
});

// A PEP 604 union in an annotation: a `def` signature (parameters or return)
// or an annotated name (`x: int | None = ...`). `X | Y` between two type-ish
// names; dict literals are skipped because their keys are quoted.
const UNION = /[\w\]]\s*\|\s*[\w[]/;
const unionAnnotationLines = (source) => {
  const hits = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(async\s+)?def\s/.test(line)) {
      // Collect a multi-line signature up to the line that ends it with ':'.
      let sig = line;
      let j = i;
      while (!/\)\s*(->[^#]*)?:\s*(#.*)?$/.test(lines[j]) && j + 1 < lines.length) {
        j += 1;
        sig += `\n${lines[j]}`;
      }
      if (UNION.test(sig.replace(/(['"]).*?\1/g, ''))) hits.push(i + 1);
    } else {
      const annotated = line.match(/^\s*[A-Za-z_][\w.]*\s*:\s*([^=#]+)/);
      if (annotated && UNION.test(annotated[1])) hits.push(i + 1);
    }
  }
  return hits;
};

const FUTURE_IMPORT = /^from __future__ import .*\bannotations\b/m;

describe('examples/*.py run on Python 3.9 (F109)', () => {
  const files = listPy(EXAMPLES);

  it('finds the hello-world bot among the examples', () => {
    expect(files).toContain(BOT_FILE);
  });

  it('the union detector sees `-> str | None` (control)', () => {
    expect(unionAnnotationLines('def f(evt: dict) -> str | None:\n    return None\n')).toEqual([1]);
    expect(unionAnnotationLines('x = {"a": 1 | 2}\n')).toEqual([]);
  });

  it.each(files.map((f) => [path.relative(REPO_ROOT, f), f]))(
    '%s: a PEP 604 union in an annotation comes with `from __future__ import annotations`',
    (_rel, file) => {
      const source = fs.readFileSync(file, 'utf8');
      const hits = unionAnnotationLines(source);
      if (hits.length === 0) return;
      expect({ file: _rel, unionLines: hits, hasFutureImport: FUTURE_IMPORT.test(source) })
        .toEqual({ file: _rel, unionLines: hits, hasFutureImport: true });
    },
  );
});

// Every distinct python3 on this machine: PATH's, and macOS's stock one,
// which is the 3.9 that crashed.
const pythons = (() => {
  const seen = new Map();
  for (const bin of ['python3', '/usr/bin/python3']) {
    const probe = spawnSync(bin, ['-c', 'import sys; print(sys.executable, "%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (probe.status === 0) {
      const [exe, version] = probe.stdout.trim().split(' ');
      if (!seen.has(exe)) seen.set(exe, [`${bin} (${version})`, bin]);
    }
  }
  return [...seen.values()];
})();

// The frame stack ahead of the message, as the kernel builds it: frames, a
// blank line, then the text. The text holds a blank line of its own.
const TEXT = 'hello from the walk\n\nsecond paragraph';
const FRAMED = `[Pod context: this conversation is in pod \`p1\`.]\n[Author: @owner]\n\n${TEXT}`;

// The layout `agent init` writes: bot.py with commonly.py beside it.
let scaffoldDir;

const runHandleEvent = (bin, evt) => {
  const script = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("hello_bot", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'print(json.dumps(mod.handle_event(json.loads(sys.argv[2]))))',
  ].join('\n');
  // -I: ignore PYTHON* env and the user site; bot.py adds its own dir for commonly.py.
  const run = spawnSync(bin, ['-I', '-c', script, path.join(scaffoldDir, 'bot.py'), JSON.stringify(evt)], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${bin} exited ${run.status}: ${run.stderr.trim().split('\n').slice(-1)[0]}`);
  return JSON.parse(run.stdout);
};

const describeIfPython = pythons.length ? describe : describe.skip;

describeIfPython('hello-world bot.py handle_event (F109)', () => {
  beforeAll(() => {
    scaffoldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commonly-f109-'));
    fs.copyFileSync(BOT_FILE, path.join(scaffoldDir, 'bot.py'));
    fs.copyFileSync(SDK_FILE, path.join(scaffoldDir, 'commonly.py'));
  });

  afterAll(() => {
    if (scaffoldDir) fs.rmSync(scaffoldDir, { recursive: true, force: true });
  });

  it.each(pythons)('%s: echoes only the message from rawContent, not the frames', (_label, bin) => {
    const reply = runHandleEvent(bin, {
      type: 'chat.mention',
      payload: { content: FRAMED, rawContent: TEXT },
    });
    expect(reply).toBe(`echo: ${TEXT}`);
  });

  it.each(pythons)('%s: falls back to content when an older server sends no rawContent', (_label, bin) => {
    expect(runHandleEvent(bin, { type: 'message.posted', payload: { content: 'hi' } })).toBe('echo: hi');
  });

  it.each(pythons)('%s: ignores events that are not chat', (_label, bin) => {
    expect(runHandleEvent(bin, { type: 'summary.request', payload: { rawContent: 'x' } })).toBeNull();
  });
});
