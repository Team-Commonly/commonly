const { POSTHOG_ENTRY } = require('../../../integrations/hostedMcp/posthog');
const { HOSTED_MCP_ENTRIES } = require('../../../integrations/hostedMcp/entries');
const { assessEntryTools, canonicalJson } = require('../../../services/hostedMcpEntryService');
const capture = require('../../fixtures/hostedMcp/posthog-selected-tools-2026-10-21.json');

test('PostHog registers only the selected native tools from the consenting tools-mode capture', () => {
  expect(HOSTED_MCP_ENTRIES).toContain(POSTHOG_ENTRY);
  expect(capture.server).toBe(POSTHOG_ENTRY.resource);
  expect(POSTHOG_ENTRY.audience).toBe('https://mcp.posthog.com/mcp');
  expect(capture.toolCountInFullCapture).toBe(780);
  expect(capture.requestedScope).toBeNull(); // Scope narrowing needs its own consent check.
  expect(POSTHOG_ENTRY.tools.map((tool) => tool.upstreamName)).toEqual(capture.tools.map((tool) => tool.name));
  expect(POSTHOG_ENTRY.tools).toHaveLength(9);
  expect(POSTHOG_ENTRY.tools.filter((tool) => tool.class === 'read')).toHaveLength(7);
  expect(POSTHOG_ENTRY.tools.filter((tool) => tool.class === 'write')).toHaveLength(2);
  expect(POSTHOG_ENTRY.tools.some((tool) => tool.name === 'exec' || tool.name === 'execute-sql')).toBe(false);

  for (const [index, pin] of POSTHOG_ENTRY.tools.entries()) {
    const measured = capture.tools[index];
    expect(canonicalJson(pin.inputSchema)).toBe(canonicalJson(measured.inputSchema));
    expect(pin.annotations).toEqual({
      readOnlyHint: measured.annotations.readOnlyHint,
      destructiveHint: measured.annotations.destructiveHint,
    });
    expect(pin.class).toBe(measured.annotations.readOnlyHint ? 'read' : 'write');
  }
  expect(assessEntryTools(POSTHOG_ENTRY, capture.tools).every((result) => result.verdict === 'ok')).toBe(true);
});

test('a moved PostHog write schema or withdrawn read claim withholds that pin', () => {
  const changed = structuredClone(capture.tools);
  changed.find((tool) => tool.name === 'dashboard-create').inputSchema.required = ['name', 'unknown'];
  changed.find((tool) => tool.name === 'insights-list').annotations.readOnlyHint = false;
  const verdicts = new Map(assessEntryTools(POSTHOG_ENTRY, changed).map((item) => [item.name, item.verdict]));
  expect(verdicts.get('dashboard-create')).toBe('tool_drift');
  expect(verdicts.get('insights-list')).toBe('tool_drift');
});
