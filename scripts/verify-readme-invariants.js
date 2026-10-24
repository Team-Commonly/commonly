#!/usr/bin/env node
/**
 * README invariant check.
 *
 * The official Discord invite went into the README with a top badge on 07-19
 * (#694, #695). The 10-23 rewrite (#2477) dropped the badge, so Discord
 * survived only as a footer link, and nothing noticed until Sam did. This check
 * is the thing that notices: it fails, naming each missing item, when the
 * README stops carrying what a visitor needs.
 *
 * The rules are below. To change them, edit RULES here and record the reason in
 * docs/design/readme-benchmark.md (TASK-422), which is where the README's
 * structure is argued. Do not add a rule without a reason there.
 *
 * Usage: node scripts/verify-readme-invariants.js [path]
 *        node scripts/verify-readme-invariants.js --self-test
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'README.md');
const TOP_LINES = 40;
const DISCORD_INVITE = 'https://discord.gg/NsS3fzsJDw';

// Each rule: a name a reader can act on, and a test over the README text.
const RULES = [
  {
    name: `the Discord invite (${DISCORD_INVITE}) within the first ${TOP_LINES} lines`,
    check: (lines) => lines.slice(0, TOP_LINES).join('\n').includes(DISCORD_INVITE),
  },
  {
    name: 'a link to the docs',
    check: (lines) => /\]\((docs\/|https:\/\/docs\.commonly\.me)/.test(lines.join('\n')),
  },
  {
    name: 'a link to the license (LICENSE)',
    check: (lines) => /\]\((\.\/)?LICENSE\)/.test(lines.join('\n')),
  },
  {
    name: 'a quickstart section or link',
    check: (lines) => /^#{1,6} .*quick ?start/im.test(lines.join('\n'))
      || /\]\([^)]*quickstart[^)]*\)/i.test(lines.join('\n')),
  },
];

function checkReadme(text) {
  const lines = text.split('\n');
  return RULES.filter((rule) => !rule.check(lines)).map((rule) => `missing ${rule.name}`);
}

function selfTest() {
  const complete = [
    `[![Discord](https://img.shields.io/badge/chat-discord-blue)](${DISCORD_INVITE})`,
    '## Quick Start',
    '[Docs](docs/README.md) · [License](LICENSE)',
  ].join('\n');
  if (checkReadme(complete).length !== 0) {
    throw new Error('self-test: a complete fixture was reported as missing something');
  }

  // A README without the invite must fail, and must name the invite.
  const noInvite = complete.replace(DISCORD_INVITE, 'https://example.com');
  const problems = checkReadme(noInvite);
  if (!problems.some((p) => p.includes(DISCORD_INVITE))) {
    throw new Error(`self-test: a README without the invite did not fail naming it: ${JSON.stringify(problems)}`);
  }

  // The invite past line 40 is a footer, not a top link: it must fail too.
  const padded = `${'filler\n'.repeat(TOP_LINES)}${DISCORD_INVITE}\n## Quick Start\n[D](docs/x.md)\n[L](LICENSE)`;
  if (!checkReadme(padded).some((p) => p.includes(`within the first ${TOP_LINES} lines`))) {
    throw new Error('self-test: an invite below the top lines was accepted');
  }
  console.log('readme invariants self-test: ok');
}

function main(argv) {
  if (argv.includes('--self-test')) {
    selfTest();
    return 0;
  }
  const file = argv.find((a) => !a.startsWith('--')) || DEFAULT_FILE;
  const problems = checkReadme(fs.readFileSync(file, 'utf8'));
  if (problems.length > 0) {
    console.error(`README invariants failed for ${path.relative(process.cwd(), file)}:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`README invariants: ok (${RULES.length} rules)`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { checkReadme, RULES, DISCORD_INVITE };
