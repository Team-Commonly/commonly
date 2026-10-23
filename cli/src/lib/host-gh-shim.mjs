#!/usr/bin/env node
/** Narrow gh-compatible entrypoint for confined Commonly host seats. */
import { connect } from 'net';

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
};

const parse = (argv) => {
  const parts = [...argv];
  const grantFlag = parts.indexOf('--grant-id');
  if (grantFlag < 0 || grantFlag + 1 >= parts.length) throw new Error('pass --grant-id <grant>');
  const [grantId] = parts.splice(grantFlag + 1, 1);
  parts.splice(grantFlag, 1);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(grantId)) throw new Error('invalid grant id');

  const [area, action, ...rest] = parts;
  let operation;
  let requiredFlags = [];
  let allowedFlags = [];
  let numberField;
  if (area === 'pr' && action === 'create') {
    operation = 'pr.create';
    requiredFlags = ['--title', '--head', '--base'];
    allowedFlags = [...requiredFlags, '--body', '--draft'];
  } else if (area === 'pr' && action === 'view') {
    operation = 'pr.view'; numberField = 'pullNumber';
  } else if (area === 'pr' && action === 'comment') {
    operation = 'pr.comment'; numberField = 'pullNumber';
    requiredFlags = ['--body']; allowedFlags = requiredFlags;
  } else if (area === 'pr' && action === 'review') {
    operation = 'pr.review_comment'; numberField = 'pullNumber';
    requiredFlags = ['--comment', '--body']; allowedFlags = requiredFlags;
  } else if (area === 'issue' && action === 'comment') {
    operation = 'issue.comment'; numberField = 'issueNumber';
    requiredFlags = ['--body']; allowedFlags = requiredFlags;
  } else {
    throw new Error('gh operation is not allowed for this seat');
  }

  const args = {};
  if (numberField) {
    const value = rest.shift();
    if (!/^[1-9][0-9]*$/.test(value || '') || !Number.isSafeInteger(Number(value))) {
      throw new Error('pass a positive issue or PR number');
    }
    args[numberField] = Number(value);
  }
  const flags = new Set();
  while (rest.length) {
    const flag = rest.shift();
    if (!allowedFlags.includes(flag) || flags.has(flag)) throw new Error(`flag is not allowed: ${flag}`);
    flags.add(flag);
    if (flag === '--draft' || flag === '--comment') continue;
    const value = rest.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (value.length > 32 * 1024) throw new Error(`value is too long for ${flag}`);
    args[flag.slice(2)] = value;
  }
  if (requiredFlags.some((flag) => !flags.has(flag))) throw new Error('required flag is missing');
  if (flags.has('--draft')) args.draft = true;
  return { grantId, operation, args };
};

const main = async () => {
  const request = parse(process.argv.slice(2));
  const socketPath = process.env.COMMONLY_GH_SOCKET;
  if (!socketPath || !socketPath.startsWith('/')) throw new Error('seat GitHub broker is unavailable');
  const answer = await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const chunks = [];
    let size = 0;
    socket.setTimeout(20_000, () => socket.destroy(new Error('seat GitHub broker timed out')));
    socket.on('connect', () => socket.end(JSON.stringify(request)));
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > 128 * 1024) socket.destroy(new Error('seat GitHub response is too large'));
      else chunks.push(chunk);
    });
    socket.on('error', reject);
    socket.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {
        reject(new Error('seat GitHub response is invalid'));
      }
    });
  });
  if (answer.status < 200 || answer.status >= 300 || answer.status === 202) {
    throw new Error(answer.body?.error || answer.body?.status || 'GitHub operation refused');
  }
  process.stdout.write(`${JSON.stringify(answer.body, null, 2)}\n`);
};

main().catch((error) => fail(error.message));
