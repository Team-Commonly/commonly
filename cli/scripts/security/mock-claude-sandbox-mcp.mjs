#!/usr/bin/env node

/**
 * Live-attack MCP server for verify-public-claude-seatbelt.mjs.
 *
 * Unlike the Codex capture server, this one exposes direct filesystem and
 * process attacks. It runs as a child of Claude and therefore inherits the
 * outer Seatbelt policy; a denied result proves the kernel boundary applies
 * to declared MCP children as well as Claude's built-in tools.
 */

import { execFile } from 'child_process';
import { appendFile, readFile, writeFile } from 'fs/promises';
import readline from 'readline';

const captureFile = process.env.CAPTURE_FILE;
const debugFile = process.env.DEBUG_FILE;
if (!captureFile) {
  process.stderr.write('CAPTURE_FILE is required\n');
  process.exit(2);
}

const debug = async (event) => {
  if (!debugFile) return;
  await appendFile(debugFile, `${JSON.stringify(event)}\n`, 'utf8');
};

const reply = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
};

const toolResult = (text) => ({
  content: [{ type: 'text', text }],
});

const safeError = (err) => `OS_ERROR ${err?.code || 'UNKNOWN'}: ${err?.message || String(err)}`;

const exec = (file, args) => new Promise((resolve) => {
  execFile(file, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
    resolve(err ? safeError(err) : `${stdout}${stderr}`.trim());
  });
});

const tools = [
  {
    name: 'attempt_file_read',
    description: 'Attempt to read an exact path and return content or the raw OS error.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'attempt_file_write',
    description: 'Attempt to write content to an exact path and return success or the raw OS error.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'attempt_shell_read',
    description: 'Attempt an exact /bin/sh cat command and return output or the raw OS error.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_environment',
    description: 'Return only environment variable names that look like Commonly credentials.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'record_observation',
    description: 'Record an access-control observation supplied by the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['source', 'content'],
      additionalProperties: false,
    },
  },
];

await debug({ event: 'started', pid: process.pid });

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

input.on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (err) {
    await debug({ event: 'parse-error', line, error: err.message });
    return;
  }
  await debug({ event: 'message', method: message.method, id: message.id });

  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'commonly-claude-sandbox-attack', version: '1.0.0' },
    });
    return;
  }
  if (message.method === 'tools/list') {
    reply(message.id, { tools });
    return;
  }
  if (message.method !== 'tools/call') return;

  const args = message.params?.arguments || {};
  let output;
  if (message.params?.name === 'attempt_file_read') {
    try {
      output = await readFile(args.path, 'utf8');
    } catch (err) {
      output = safeError(err);
    }
  } else if (message.params?.name === 'attempt_file_write') {
    try {
      await writeFile(args.path, args.content, 'utf8');
      output = 'WRITE_OK';
    } catch (err) {
      output = safeError(err);
    }
  } else if (message.params?.name === 'attempt_shell_read') {
    output = await exec('/bin/sh', ['-c', `cat -- "$1"`, 'sandbox-attack', args.path]);
  } else if (message.params?.name === 'inspect_environment') {
    const credentialKeys = Object.keys(process.env)
      .filter((key) => /^(?:COMMONLY_|cm_agent_)/i.test(key))
      .sort();
    output = JSON.stringify({
      keys: credentialKeys,
      runtimeTokenResolved: /^cm_agent_[A-Za-z0-9]+$/
        .test(process.env.COMMONLY_AGENT_TOKEN || ''),
    });
  } else if (message.params?.name === 'record_observation') {
    output = 'OBSERVATION_RECORDED';
  } else {
    reply(message.id, {
      content: [{ type: 'text', text: 'unknown tool' }],
      isError: true,
    });
    return;
  }

  await appendFile(
    captureFile,
    `${JSON.stringify({
      tool: message.params.name,
      arguments: args,
      output,
    })}\n`,
    'utf8',
  );
  reply(message.id, toolResult(output));
});
