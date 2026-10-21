/**
 * Gemini thought signatures through an OpenAI-compatible client.
 *
 * Gemini 3 signs the function calls of each step it thinks through and turns
 * the next request away without that signature back on the call: 400
 * "Function call is missing a thought_signature in functionCall parts". Its
 * OpenAI-compatible API returns the signature beside the call, in
 * tool_calls[].extra_content.google.thought_signature, and takes it back
 * there. OpenCode's provider (@ai-sdk/openai-compatible) knows no such field
 * and drops it, so every Gemini 3 tool loop through OpenCode failed on its
 * second request (walked 2026-10-19).
 *
 * Every Chat client does send a call's id back as it was given. So the proxy
 * gives the client an id carrying a short reference to the signature,
 * `<id>__cmts16__<key>`, keeps the signature in a store under that key, and on
 * the way back takes the reference off the id and puts the signature into
 * extra_content. A call whose signature can't be recovered (another model's
 * call, an id the client shortened, a store that lost it) goes to Gemini with
 * `skip_thought_signature_validator`, the value Google documents for history
 * it didn't sign.
 *
 * The approach is yetone's, from magpie's gateway
 * (https://github.com/yetone/magpie, internal/gateway/gemini_signature.go and
 * gemini_sigstore.go at a9304efe). This is a separate JavaScript
 * implementation for Commonly's per-spawn provider proxy, and magpie's notice
 * is reproduced here:
 *
 *   MIT License
 *
 *   Copyright (c) 2026 yetone
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */
import { createHash, randomBytes } from 'crypto';
import {
  mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile,
} from 'fs/promises';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';

/** The hosts whose OpenAI-compatible API needs signatures carried back. */
const GEMINI_OPENAI_HOSTS = new Set(['generativelanguage.googleapis.com']);

export const isGeminiOpenAIUpstream = (baseURL) => {
  try {
    return GEMINI_OPENAI_HOSTS.has(new URL(baseURL).hostname.toLowerCase());
  } catch {
    return false;
  }
};

export const SKIP_SIGNATURE = 'skip_thought_signature_validator';

// The reference in an id: MARK, the key's length, `__`, the key. The length
// tells a whole key from one a client cut short, which then reads as no
// signature rather than as some other key.
const MARK = '__cmts';
const KEY_BYTES = 12; // 16 base64url characters
const KEY_LENGTH = 16;
const SIGNED_ID_RE = new RegExp(`^([\\s\\S]*?)${MARK}(\\d+)__([A-Za-z0-9_-]*)$`);

export const signedId = (id, key) => `${id}${MARK}${key.length}__${key}`;

/** `{ id, key }`: the call's own id and its signature's key, or the id as given and null. */
export const unsignedId = (id) => {
  if (typeof id !== 'string') return { id, key: null };
  const match = SIGNED_ID_RE.exec(id);
  if (!match || Number(match[2]) !== match[3].length || match[3].length !== KEY_LENGTH) {
    return { id, key: null };
  }
  return { id: match[1], key: match[3] };
};

const signatureKey = (signature) => createHash('sha256').update(signature).digest()
  .subarray(0, KEY_BYTES).toString('base64url');

const SIGNATURE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Signatures by key: in memory for this spawn, and in `dir` (0700, one 0600
 * file per signature, named by its hash) so a seat's next turn finds the calls
 * its earlier turns made. Without a dir it is memory only. A file is written
 * whole, staged then renamed. A failed write or read is no signature, which
 * Gemini takes as unsigned history.
 */
export const createSignatureStore = (dir = null) => {
  const memory = new Map();
  let ready = null;
  const ensureDir = () => {
    if (!dir) return Promise.resolve(false);
    ready = ready || mkdir(dir, { recursive: true, mode: 0o700 }).then(() => true, () => false);
    return ready;
  };
  return {
    async keep(signature) {
      const key = signatureKey(signature);
      memory.set(key, signature);
      if (await ensureDir()) {
        const target = join(dir, key);
        const staged = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(staged, signature, { encoding: 'utf8', mode: 0o600 });
          await rename(staged, target);
        } catch {
          await rm(staged, { force: true }).catch(() => {});
        }
      }
      return key;
    },
    async lookup(key) {
      if (memory.has(key)) return memory.get(key);
      if (!dir || !/^[A-Za-z0-9_-]{16}$/.test(key)) return null;
      try {
        const path = join(dir, key);
        const signature = await readFile(path, 'utf8');
        if (!signature || signatureKey(signature) !== key) return null;
        const now = new Date();
        await utimes(path, now, now).catch(() => {});
        memory.set(key, signature);
        return signature;
      } catch {
        return null;
      }
    },
    /** Remove signatures not read for 30 days, and staged files left behind. */
    async prune(now = Date.now()) {
      if (!dir) return;
      let names = [];
      try { names = await readdir(dir); } catch { return; }
      await Promise.all(names.map(async (name) => {
        try {
          const details = await stat(join(dir, name));
          const age = now - details.mtimeMs;
          if (age > SIGNATURE_KEEP_MS || (name.endsWith('.tmp') && age > 60 * 60 * 1000)) {
            await rm(join(dir, name), { force: true });
          }
        } catch { /* gone already */ }
      }));
    },
  };
};

const googleSignature = (call) => {
  const signature = call?.extra_content?.google?.thought_signature;
  return typeof signature === 'string' && signature ? signature : null;
};

/**
 * A chat/completions request body for Gemini with the references taken off
 * its call ids and each signed step's signature back in extra_content. Gemini
 * signs the first call of a step, so only a step with no signature at all gets
 * the skip value, on every call. Returns the body unchanged when it is not
 * JSON or nothing changed.
 */
export const restoreRequestSignatures = async (body, store) => {
  let request;
  try { request = JSON.parse(body.toString('utf8')); } catch { return body; }
  if (!request || !Array.isArray(request.messages)) return body;
  let changed = false;
  for (const message of request.messages) {
    if (!message || typeof message !== 'object') continue;
    if (typeof message.tool_call_id === 'string') {
      const { id, key } = unsignedId(message.tool_call_id);
      if (key) { message.tool_call_id = id; changed = true; }
    }
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    const signatures = [];
    for (const call of message.tool_calls) {
      let signature = googleSignature(call);
      const { id, key } = unsignedId(call?.id);
      if (key) {
        call.id = id;
        changed = true;
        // eslint-disable-next-line no-await-in-loop
        signature = signature || await store.lookup(key);
      }
      signatures.push(signature);
    }
    const signedStep = signatures.some(Boolean);
    message.tool_calls.forEach((call, index) => {
      if (!call || typeof call !== 'object') return;
      const signature = signatures[index] || (signedStep ? null : SKIP_SIGNATURE);
      if (!signature || googleSignature(call) === signature) return;
      call.extra_content = { ...(call.extra_content || {}), google: { ...(call.extra_content?.google || {}), thought_signature: signature } };
      changed = true;
    });
  }
  return changed ? Buffer.from(JSON.stringify(request), 'utf8') : body;
};

/** Give each signed call in one reply (or one streamed chunk) an id carrying its key. */
const signReplyObject = async (reply, store) => {
  if (!reply || !Array.isArray(reply.choices)) return false;
  let changed = false;
  for (const choice of reply.choices) {
    for (const field of ['message', 'delta']) {
      const calls = choice?.[field]?.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        const signature = googleSignature(call);
        if (!signature || typeof call.id !== 'string' || !call.id) continue;
        if (unsignedId(call.id).key) continue;
        // eslint-disable-next-line no-await-in-loop
        call.id = signedId(call.id, await store.keep(signature));
        changed = true;
      }
    }
  }
  return changed;
};

const SIGNATURE_FIELD = '"thought_signature"';

/**
 * Rewrites a Gemini chat/completions reply as it streams to the client. An SSE
 * reply is rewritten line by line, and a line passes as it came unless it is a
 * `data:` chunk carrying a signature; any other reply is rewritten whole at
 * the end. `write` and `end` return the bytes to send now.
 */
export const createReplySigner = ({ store, sse }) => {
  // A chunk can end inside a multi-byte character; decode across chunks.
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const signLine = async (line) => {
    if (!line.includes(SIGNATURE_FIELD)) return line;
    const body = line.replace(/\r?\n$/, '');
    if (!body.startsWith('data:')) return line;
    let chunk;
    try { chunk = JSON.parse(body.slice(5).trim()); } catch { return line; }
    if (!await signReplyObject(chunk, store)) return line;
    return `data: ${JSON.stringify(chunk)}${line.slice(body.length)}`;
  };
  const signLines = async (text) => {
    if (!text.includes(SIGNATURE_FIELD)) return text;
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
    const out = [];
    // eslint-disable-next-line no-await-in-loop
    for (const line of lines) out.push(await signLine(line));
    return out.join('');
  };
  return {
    async write(chunk) {
      pending += decoder.write(chunk);
      if (!sse) return '';
      const cut = pending.lastIndexOf('\n');
      if (cut < 0) return '';
      const complete = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      return signLines(complete);
    },
    async end() {
      const rest = pending + decoder.end();
      pending = '';
      if (sse) return signLines(rest);
      if (!rest.includes(SIGNATURE_FIELD)) return rest;
      let reply;
      try { reply = JSON.parse(rest); } catch { return rest; }
      return await signReplyObject(reply, store) ? JSON.stringify(reply) : rest;
    },
  };
};
