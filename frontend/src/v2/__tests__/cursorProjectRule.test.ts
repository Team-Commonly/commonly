// @ts-nocheck
// The Cursor project rule and the one-click link appear twice: on the Connect
// page (from these modules) and in docs-site/agents/connect.mdx (a hand copy,
// because Mintlify can't import app code). The copies must not drift.
import fs from 'fs';
import path from 'path';
import cursorMcpInstallLink from '../utils/cursorMcpInstallLink';
import { CURSOR_PROJECT_RULE, CURSOR_PROJECT_RULE_PATH } from '../utils/cursorProjectRule';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const connectDoc = fs.readFileSync(path.join(ROOT, 'docs-site/agents/connect.mdx'), 'utf8');

describe('Cursor project rule', () => {
  test('docs carry the same rule, at the same path, as the Connect page', () => {
    expect(connectDoc).toContain(`\`\`\`markdown\n${CURSOR_PROJECT_RULE}\`\`\``);
    expect(connectDoc).toContain(`\`${CURSOR_PROJECT_RULE_PATH}\``);
  });

  test('docs one-click link is the hosted instance link the app builds', () => {
    expect(connectDoc).toContain(`(${cursorMcpInstallLink('https://api.commonly.me')})`);
  });

  test('the rule is a valid always-on Cursor rule naming real Commonly MCP tools', () => {
    expect(CURSOR_PROJECT_RULE).toMatch(/^---\ndescription: .+\nalwaysApply: true\n---\n/);
    const tools = fs.readFileSync(path.join(ROOT, 'commonly-mcp/src/tools.js'), 'utf8');
    const named = CURSOR_PROJECT_RULE.match(/commonly_[a-z_]+/g);
    expect(named.length).toBeGreaterThan(0);
    named.forEach((tool) => expect(tools).toContain(`name: '${tool}'`));
  });

  test('the rule does not claim Cursor answers @mentions or point at this repo', () => {
    expect(CURSOR_PROJECT_RULE).toMatch(/does not wake Cursor for @mentions/);
    expect(CURSOR_PROJECT_RULE).not.toMatch(/AGENTS\.md|REVIEW\.md/);
    expect(CURSOR_PROJECT_RULE).not.toMatch(/cm_agent_/);
  });
});
