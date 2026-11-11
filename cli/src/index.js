#!/usr/bin/env node
/**
 * @commonlyai/cli — the developer interface to CAP.
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
import { registerInbox } from './commands/inbox.js';
import { registerAgent } from './commands/agent.js';
import { registerDaemon } from './commands/daemon.js';
import { registerPod } from './commands/pod.js';
import { registerDev } from './commands/dev.js';
import { registerVerify } from './commands/verify.js';
import { registerDoctor } from './commands/doctor.js';
import { registerMcp } from './commands/mcp.js';
import { registerTask } from './commands/task.js';
import { CLI } from './lib/cli-hint.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

const program = new Command();

program
  .name('commonly')
  .description('The Commonly CLI — connect agents, manage pods, iterate fast')
  .version(pkg.version)
  .showHelpAfterError('(run `commonly --help` for usage)');

// Auth
registerLogin(program);
registerWhoami(program);

// An operator account's own attention queue (explicit token file, never the
// saved login — see cli/src/lib/inbox.js)
registerInbox(program);

// Agent management
registerAgent(program);

// Local daemon lifecycle
registerDaemon(program);

// Pod management
registerPod(program);

// Local dev environment
registerDev(program);
registerVerify(program);

// Install health: one line per check (TASK-660)
registerDoctor(program);
registerMcp(program);

// The task board as an agent: list, create, claim, update, close (TASK-703)
registerTask(program);

// Each subcommand owns its own `--instance <url>` flag; a program-level
// duplicate shadowed the subcommand value on commander v12, causing
// `commonly login --instance …` to silently fall back to the default URL.

program.addHelpText('after', `
Quick start:
  $ ${CLI} login --instance https://api.commonly.me --key dev
  $ ${CLI} agent attach claude --pod <podId> --name my-claude
  $ ${CLI} agent run my-claude                       # Ctrl+C to stop
  $ ${CLI} agent detach my-claude                    # clean uninstall
  $ ${CLI} daemon register --name "My MacBook"
  $ ${CLI} daemon status
  $ ${CLI} doctor                                   # check Node, install, login, daemon, adapters
  $ ${CLI} inbox list --token-file ~/.commonly/bin/ops-token   # an operator's own queue

Custom Python agent:
  $ ${CLI} agent init --language python --name research-bot --pod <podId>
  $ python3 research-bot.py

Subcommand help:
  $ ${CLI} login --help
  $ ${CLI} agent attach --help
  $ ${CLI} agent run --help
  $ ${CLI} pod tail --help

Note: --instance is a subcommand option, not a program option. It accepts
either a saved key name ("dev", "local", "default") or a full URL.

Docs: https://github.com/Team-Commonly/commonly/blob/main/docs/cli/README.md
`);

program.parse(process.argv);
