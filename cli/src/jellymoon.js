#!/usr/bin/env node
/**
 * The `jellymoon` bin: `jellymoon run <claude|codex|opencode|goose> "<task>"`.
 * The same command as `commonly jellymoon run`, without the rest of the
 * Commonly CLI; see src/commands/jellymoon.js and packages/seats/README.md.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJellymoonProgram } from './commands/jellymoon.js';

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));

await buildJellymoonProgram({ version: pkg.version }).parseAsync(process.argv);
