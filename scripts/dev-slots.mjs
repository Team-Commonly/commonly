#!/usr/bin/env node
// Slot registry for ./dev.sh up --ephemeral (D177, TASK-619).
// Each worktree gets one slot: a number, two ports and one Mongo/Postgres
// database name. State lives in ~/.commonly/dev/slots.json. Callers hold the
// registry lock (scripts/dev-ephemeral.sh); this script does no locking itself.
//
//   claim <worktreePath> <slug>  reuse this worktree's slot or take the lowest free one
//   set-pids <n> <backendPid> <frontendPid>
//   expired                      list slots past their TTL, one JSON object per line
//   drop <n>                     forget a slot

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DIR = process.env.COMMONLY_DEV_DIR || path.join(os.homedir(), '.commonly', 'dev');
const FILE = path.join(DIR, 'slots.json');
const MAX_SLOTS = Number(process.env.COMMONLY_DEV_MAX_SLOTS || 8);
const TTL_MS = 24 * 60 * 60 * 1000;

// Slot n owns backend 5100+10n and frontend 5101+10n. Ten ports per slot leaves room
// for the Vite HMR port and anything else a later step adds without renumbering.
const backendPort = (n) => 5100 + 10 * n;
const frontendPort = (n) => 5101 + 10 * n;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { slots: {} };
  }
}

function save(registry) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  fs.renameSync(tmp, FILE);
}

function slotDir(n) {
  return path.join(DIR, `slot-${n}`);
}

function claim(worktreePath, slug) {
  const key = crypto.createHash('sha1').update(path.resolve(worktreePath)).digest('hex').slice(0, 16);
  const registry = load();
  const now = Date.now();
  let n = Object.keys(registry.slots).find((id) => registry.slots[id].key === key);
  if (n === undefined) {
    for (let candidate = 1; candidate <= MAX_SLOTS; candidate += 1) {
      if (!registry.slots[String(candidate)]) {
        n = String(candidate);
        break;
      }
    }
  }
  if (n === undefined) {
    process.stderr.write(`all ${MAX_SLOTS} ephemeral slots are taken; run ./dev.sh gc or raise COMMONLY_DEV_MAX_SLOTS\n`);
    process.exit(3);
  }
  const previous = registry.slots[n] || {};
  const entry = {
    key,
    worktree: path.resolve(worktreePath),
    dbName: `commonly_${slug}_${n}`,
    backendPort: backendPort(Number(n)),
    frontendPort: frontendPort(Number(n)),
    createdAt: previous.createdAt || new Date(now).toISOString(),
    expiresAt: new Date(now + TTL_MS).toISOString(),
    pids: previous.pids || null,
  };
  registry.slots[n] = entry;
  save(registry);
  // Shell-safe assignments for `eval`. Every value is generated here, so none needs quoting.
  process.stdout.write(
    [
      `SLOT_N=${n}`,
      `SLOT_DIR=${slotDir(n)}`,
      `DB_NAME=${entry.dbName}`,
      `BACKEND_PORT=${entry.backendPort}`,
      `FRONTEND_PORT=${entry.frontendPort}`,
      '',
    ].join('\n'),
  );
}

function setPids(n, backend, frontend) {
  const registry = load();
  if (!registry.slots[n]) {
    process.stderr.write(`no slot ${n}\n`);
    process.exit(1);
  }
  registry.slots[n].pids = { backend: Number(backend), frontend: Number(frontend) };
  save(registry);
}

function expired() {
  const registry = load();
  const now = Date.now();
  for (const [n, entry] of Object.entries(registry.slots)) {
    if (Date.parse(entry.expiresAt) <= now) {
      process.stdout.write(`${JSON.stringify({ n, ...entry })}\n`);
    }
  }
}

function drop(n) {
  const registry = load();
  delete registry.slots[n];
  save(registry);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'claim':
    claim(args[0], args[1]);
    break;
  case 'set-pids':
    setPids(args[0], args[1], args[2]);
    break;
  case 'expired':
    expired();
    break;
  case 'drop':
    drop(args[0]);
    break;
  default:
    process.stderr.write('usage: dev-slots.mjs claim|set-pids|expired|drop\n');
    process.exit(2);
}
