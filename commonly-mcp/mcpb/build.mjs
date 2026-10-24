#!/usr/bin/env node
// Package the published MCP server code and its production dependencies as an
// MCPB. Keep the staging directory outside the repo so credentials and local
// development files cannot enter the archive by accident.
import { mkdtemp, mkdir, copyFile, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const mcpDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(mcpDir, '..');
const output = resolve(process.argv[2] || join(mcpDir, 'commonly.mcpb'));
const manifest = JSON.parse(await readFile(join(mcpDir, 'mcpb/manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(mcpDir, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  throw new Error(`MCPB version ${manifest.version} differs from @commonlyai/mcp ${pkg.version}`);
}

const stage = await mkdtemp(join(tmpdir(), 'commonly-mcpb-'));
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
};

try {
  const server = join(stage, 'server');
  await mkdir(server);
  await copyFile(join(mcpDir, 'mcpb/manifest.json'), join(stage, 'manifest.json'));
  await copyFile(join(mcpDir, 'package.json'), join(server, 'package.json'));
  await copyFile(join(mcpDir, 'package-lock.json'), join(server, 'package-lock.json'));
  await copyFile(join(repoDir, 'LICENSE'), join(stage, 'LICENSE'));
  await cp(join(mcpDir, 'src'), join(server, 'src'), { recursive: true });
  run('npm', ['ci', '--omit=dev', '--ignore-scripts'], server);
  run('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', stage, output], mcpDir);
  process.stdout.write(`${output}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
