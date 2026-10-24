#!/usr/bin/env node
/** Push-only Git remote helper for a confined host seat. No provider credential enters this process. */
import { spawn } from 'child_process';
import { connect } from 'net';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { createInterface } from 'readline';
import { join } from 'path';

const MAX_BUNDLE_BYTES = 6 * 1024 * 1024;
const OID = /^[0-9a-f]{40}$/;
const REF = /^refs\/heads\/seat\/[A-Za-z0-9._/-]+$/;
const grantId = String(process.argv[3] || '').replace(/^commonly::/, '');

const git = (args) => new Promise((resolve, reject) => {
  const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 4096) child.kill(); });
  child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 4096) child.kill(); });
  child.on('error', reject);
  child.on('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || 'git command failed'))));
});

const broker = (args) => new Promise((resolve, reject) => {
  const path = process.env.COMMONLY_GH_SOCKET;
  if (!path?.startsWith('/')) return reject(new Error('seat GitHub broker is unavailable'));
  const socket = connect(path);
  const chunks = [];
  let bytes = 0;
  socket.setTimeout(185_000, () => socket.destroy(new Error('push broker timed out')));
  socket.on('connect', () => socket.end(JSON.stringify({ grantId, operation: 'push.branch', args })));
  socket.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 128 * 1024) socket.destroy(new Error('push broker response is too large'));
    else chunks.push(chunk);
  });
  socket.on('error', reject);
  socket.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
      reject(new Error('push broker response is invalid'));
    }
  });
});

const push = async (commands) => {
  if (commands.length !== 1 || !commands[0].startsWith('push ')) {
    throw new Error('exactly one branch push is allowed');
  }
  const spec = commands[0].slice(5);
  if (spec.startsWith('+') || spec.split(':').length !== 2) throw new Error('force and deletion are not allowed');
  const [source, ref] = spec.split(':');
  if (!/^(HEAD|refs\/heads\/[A-Za-z0-9._/-]+)$/.test(source)
    || !REF.test(ref) || ref.includes('..') || ref.endsWith('.lock') || ref.endsWith('.')) {
    throw new Error('branch ref is not allowed');
  }
  const newOid = await git(['rev-parse', '--verify', `${source}^{commit}`]);
  const baseOid = await git(['merge-base', newOid, 'refs/remotes/origin/main']);
  if (!OID.test(newOid) || !OID.test(baseOid)) throw new Error('invalid local commit');
  const gitPath = await git(['rev-parse', '--git-path', 'commonly-push']);
  const directory = await mkdtemp(`${gitPath}-`);
  try {
    const file = join(directory, 'push.bundle');
    await git(['bundle', 'create', file, source, `^${baseOid}`]);
    const bundle = await readFile(file);
    if (bundle.length > MAX_BUNDLE_BYTES) throw new Error('push bundle exceeds 6 MiB');
    const answer = await broker({ ref, baseOid, newOid, bundle: bundle.toString('base64') });
    if (answer.status !== 200) throw new Error(answer.body?.error || 'broker refused push');
    return ref;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const main = async () => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(grantId)) throw new Error('invalid broker grant id');
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let batch = [];
  for await (const line of lines) {
    if (line === 'capabilities') {
      process.stdout.write('push\n\n');
    } else if (line === 'list for-push') {
      process.stdout.write('\n');
    } else if (line.startsWith('push ')) {
      batch.push(line);
    } else if (line === '' && batch.length) {
      const ref = batch[0].split(':').at(-1);
      try {
        const accepted = await push(batch);
        process.stdout.write(`ok ${accepted}\n\n`);
      } catch (error) {
        process.stdout.write(`error ${ref} ${String(error.message).replace(/[\r\n]/g, ' ')}\n\n`);
      }
      batch = [];
    } else if (line !== '') {
      throw new Error('unsupported Git remote command');
    }
  }
};

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
