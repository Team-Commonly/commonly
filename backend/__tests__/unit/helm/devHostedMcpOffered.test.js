// F82 (2026-11-04): Atlassian and Notion passed their prod agent-read walks
// (connect, a read-only grant to a hosted agent, a real read through the broker,
// grant revoke), so dev offers them. The rest stay hidden for the reasons
// values-dev.yaml gives beside each entry.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { HELM_CHART } = require('../../utils/repoRoot');

const chart = HELM_CHART;
const dev = yaml.load(fs.readFileSync(path.join(chart, 'values-dev.yaml'), 'utf8'), { json: true });
const hidden = dev.hostedMcp.hiddenEntries;

describe('dev hosted-MCP catalogue (F82)', () => {
  test.each(['atlassian', 'notion'])('%s is offered', (entry) => {
    expect(hidden).not.toContain(entry);
  });

  test.each(['google-calendar', 'gitlab', 'supabase', 'latchkey', 'github-mcp'])('%s stays hidden', (entry) => {
    expect(hidden).toContain(entry);
  });
});
