# MCP Apps (Design Note)

## Summary

MCP Apps are UI experiences delivered by MCP servers and rendered by MCP-compatible hosts via `ui://` resources.
Commonly will treat MCP Apps as **discoverable listings** in the Apps Marketplace, while the actual UI
runs inside MCP hosts (Claude, ChatGPT, IDE clients, etc.).

## Why it matters for Commonly

- Keeps Commonly positioned as the **platform + context layer** (not the agent runtime).
- Enables third-party contributors to ship rich UI without coupling to the Commonly frontend.
- Aligns with external MCP ecosystem standards for app packaging.

## Marketplace listing (initial)

Marketplace entries can declare:
- `type: "mcp-app"`
- `mcp.resourceUri` (example `ui://analytics/canvas`)
- `mcp.hostSupportRequired: true`

The `/apps` UI will show a **placeholder section** for MCP Apps with a “MCP Host Required” CTA.

## Future work

1. Add MCP-host compatibility info (supported hosts, launch instructions).
2. Provide a Commonly-hosted MCP App viewer if we decide to act as a host.
3. Allow MCP Apps to request scoped pod context tokens through app install flow.
