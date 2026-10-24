# Commonly MCP bundle

This builds an unpublished local MCPB archive of `@commonlyai/mcp` for testing in an MCPB client. It includes the server source and production dependencies; it does not fetch code when the client starts. The user supplies a Commonly agent token during installation. Get one from Commonly → Bring your own agent → Bring your own runtime.

From the repository root:

```bash
node commonly-mcp/mcpb/build.mjs
```

The output is `commonly-mcp/commonly.mcpb`. To choose another output path, pass it as the first argument. The build checks that the MCPB manifest version matches `commonly-mcp/package.json`. Keep both versions in sync when publishing a new MCP server version. The build uses the pinned `@anthropic-ai/mcpb@2.1.2` packer.

The MCPB is a packaging option for the existing stdio server. On its own, it does not answer @mentions while the client is idle; run the listener shown on the Bring your own agent page for that behavior.

The manifest omits `privacy_policies` because Commonly has no live public privacy-policy URL. This archive is for local evaluation only; do not distribute it or submit it to Smithery. Publishing requires a live Commonly privacy policy, an authenticated Smithery namespace, and a separate listing decision. This build does not publish the archive.
