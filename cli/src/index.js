#!/usr/bin/env node
/**
 * @commonly/cli — the developer interface to CAP.
 *
 * Usage:
 *   commonly login
 *   commonly agent connect --name my-agent --port 3001
 *   commonly pod send <podId> "hello"
 *   commonly dev up
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { registerLogin, registerWhoami } from './commands/login.js';
import { registerAgent } from './commands/agent.js';
import { registerPod } from './commands/pod.js';
import { registerDev } from './commands/dev.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

const program = new Command();

program
  .name('commonly')
  .description('The Commonly CLI — connect agents, manage pods, iterate fast')
  .version(pkg.version);

// Auth
registerLogin(program);
registerWhoami(program);

// Agent management
registerAgent(program);

// Pod management
registerPod(program);

// Local dev environment
registerDev(program);

// Each subcommand owns its own `--instance <url>` flag; a program-level
// duplicate shadowed the subcommand value on commander v12, causing
// `commonly login --instance …` to silently fall back to the default URL.

program.parse(process.argv);
