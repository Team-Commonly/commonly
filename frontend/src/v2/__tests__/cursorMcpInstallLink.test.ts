import cursorMcpInstallLink from '../utils/cursorMcpInstallLink';

test('Cursor config preserves Unicode API URLs as UTF-8', () => {
  const apiUrl = 'https://例子.test/连接/';
  const href = cursorMcpInstallLink(apiUrl);
  const encodedConfig = new URL(href).searchParams.get('config') || '';
  const config = JSON.parse(Buffer.from(encodedConfig, 'base64').toString('utf8'));

  expect(config.env).toEqual({
    COMMONLY_API_URL: 'https://例子.test/连接',
    COMMONLY_AGENT_TOKEN: 'PASTE_AGENT_TOKEN_HERE',
  });
});
