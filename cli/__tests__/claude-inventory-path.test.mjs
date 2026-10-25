import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('daemon PATH without local bin detects Claude and reads its installed effort help', () => {
  const home = mkdtempSync(join(tmpdir(), 'commonly-claude-inventory-'));
  try {
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(join(home, '.local/bin/claude'), '#!/bin/sh\ncase "$1" in\n--version) echo "2.1.310 (Claude Code)";;\n--help) echo "  --effort <level> Effort (low, medium, high)";;\n*) exit 2;;\nesac\n', { mode: 0o755 });
    const adapterUrl = new URL('../src/lib/adapters/claude.js', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { default: adapter } = await import(${JSON.stringify(adapterUrl)}); console.log(JSON.stringify({ detected: await adapter.detect(), inventory: await adapter.inventory() }));`],
    { env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000 });
    const result = JSON.parse(output.trim());
    expect(result.detected).toEqual(expect.objectContaining({ path: join(home, '.local/bin/claude'), version: '2.1.310' }));
    expect(result.inventory).toEqual({ models: null, efforts: ['low', 'medium', 'high'] });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
