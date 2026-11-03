const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// D239, 2026-11-03: dev carries Google Calendar credentials, but the tile stays
// hidden until the Cloud project is enrolled in Google's Workspace MCP Developer
// Preview (Wren, 10-14: OAuth works, every tool call then fails). Values-level,
// like the other tests here; the Chart Lint CI tier renders the chart.
const chart = path.join(__dirname, '../../../../k8s/helm/commonly');
const dev = yaml.load(fs.readFileSync(path.join(chart, 'values-dev.yaml'), 'utf8'));
const apiKeys = fs.readFileSync(path.join(chart, 'templates/secrets/api-keys.yaml'), 'utf8');

describe('Google Calendar on dev: credentials on, tile hidden', () => {
  test('values-dev turns the credential path on', () => {
    expect(dev.hostedMcp.googleCalendar.enabled).toBe(true);
  });

  test('that flag is what projects both prefixed secret refs into api-keys', () => {
    // The exact positive gate: an inverted `if not` would leave dev without credentials.
    const gate = '{{- if .Values.hostedMcp.googleCalendar.enabled }}';
    expect(apiKeys.split(gate)).toHaveLength(2);
    const gated = apiKeys.slice(apiKeys.indexOf(gate));
    const block = gated.slice(0, gated.indexOf('{{- end }}'));
    expect(block).toContain('key: {{ $keyPrefix }}google-calendar-client-id');
    expect(block).toContain('key: {{ $keyPrefix }}google-calendar-client-secret');
  });

  test('the entry stays hidden from people outside the operator allowlist', () => {
    expect(dev.hostedMcp.hiddenEntries).toContain('google-calendar');
  });
});
