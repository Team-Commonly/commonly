// Cursor's install deeplink contains its MCP configuration in the URL. Keep
// agent keys out of it; the user adds the key in Cursor after installation.
export const CURSOR_TOKEN_PLACEHOLDER = 'PASTE_AGENT_TOKEN_HERE';

const cursorMcpInstallLink = (apiUrl: string): string => {
  const config = {
    command: 'npx',
    args: ['-y', '@commonlyai/mcp'],
    env: {
      COMMONLY_API_URL: apiUrl.replace(/\/+$/, ''),
      COMMONLY_AGENT_TOKEN: CURSOR_TOKEN_PLACEHOLDER,
    },
  };
  const encodedConfig = btoa(JSON.stringify(config));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=commonly&config=${encodeURIComponent(encodedConfig)}`;
};

export default cursorMcpInstallLink;
