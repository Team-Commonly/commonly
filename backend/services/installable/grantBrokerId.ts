/**
 * The MCP server name `routes/mcpGrants.ts` announces; one URL per grant.
 *
 * A leaf module so the grant services can name the broker without loading
 * `toolInstallables`, which imports `roomGrantService` and checks the hosted-MCP
 * catalogue when it loads. `toolInstallables` re-exports it.
 */
export const GRANT_BROKER_ID = 'commonly-grant-broker';
