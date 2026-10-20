// Every hosted-MCP request goes through the outbound guard (TASK-253), and
// stays that way.
//
// The guard's own rules are tested in outboundUrlGuard.vendorEndpoint.test.js.
// This file checks the wiring: the shared wrapper uses the guarded fetch when
// no fetch is injected, and no hosted-MCP module falls back to the platform
// `fetch`. That fallback is the regression that would undo TASK-253 silently,
// because every test injects its own fetch and would stay green.
const fs = require('fs');
const path = require('path');

jest.mock('../../../services/hostedVendorFetch', () => ({
  HOSTED_VENDOR_MAX_RESPONSE_BYTES: 4 * 1024 * 1024,
  hostedVendorFetch: jest.fn(async () => new Response('{}', { status: 200 })),
}));

const { hostedVendorFetch } = require('../../../services/hostedVendorFetch');
const { upstreamFetch } = require('../../../services/upstreamFetch');

const SERVICES = path.resolve(__dirname, '../../../services');
const ROUTES = path.resolve(__dirname, '../../../routes');
// Every module that sends a request to a hosted-MCP vendor.
const HOSTED_REQUEST_MODULES = [
  path.join(SERVICES, 'hostedMcpToolDefinitions.ts'),
  path.join(SERVICES, 'hostedMcpIntakeService.ts'),
  path.join(SERVICES, 'hostedMcpCredentialService.ts'),
  path.join(SERVICES, 'hostedMcpDcrRegistry.ts'),
  path.join(SERVICES, 'connectionRemovalService.ts'),
  path.join(SERVICES, 'upstreamFetch.ts'),
  path.join(ROUTES, 'hostedMcpConnect.ts'),
];

describe('hosted-MCP requests are wired through the outbound guard', () => {
  test('upstreamFetch uses the guarded fetch when no fetch is injected', async () => {
    const platformFetch = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      throw new Error('the platform fetch must not be reached');
    });
    try {
      const response = await upstreamFetch('https://auth.vendor.test/token', { method: 'POST', body: 'x=1' });
      expect(response.status).toBe(200);
      expect(hostedVendorFetch).toHaveBeenCalledTimes(1);
      expect(hostedVendorFetch.mock.calls[0][0]).toBe('https://auth.vendor.test/token');
      expect(platformFetch).not.toHaveBeenCalled();
    } finally {
      platformFetch.mockRestore();
    }
  });

  test.each(HOSTED_REQUEST_MODULES.map((file) => [path.relative(path.resolve(__dirname, '../../..'), file), file]))(
    '%s neither defaults to nor calls the platform fetch',
    (_name, file) => {
      const source = fs.readFileSync(file, 'utf8');
      // A default parameter or property of the platform fetch: `= fetch`, `: fetch`, `=> fetch(`.
      expect(source).not.toMatch(/(?:=|:)\s*fetch\s*[,)]/);
      expect(source).not.toMatch(/=>\s*fetch\(/);
      // A direct call to the platform fetch. Wrapper and injected names are excluded.
      expect(source).not.toMatch(/(?<![A-Za-z_.])fetch\(/);
    },
  );
});
