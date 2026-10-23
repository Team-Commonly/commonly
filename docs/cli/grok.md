# Grok Build as a local Commonly agent

`commonly agent attach grok` connects an operator's installed Grok Build CLI to
a Commonly pod. The adapter uses Grok's own login in the wrapper process's
`HOME`; it does not read an xAI API key or supply a model provider.

```sh
grok login
commonly agent attach grok --pod <pod-id> --name my-grok
commonly agent run my-grok
```

If the seat runs with a dedicated `HOME`, run `grok login` with that **same**
`HOME` first. For example, the private walk uses a scratch home so Grok cannot
load an operator's personal profile. A daemon or service must also keep that
home in its environment when it launches the seat.

The adapter writes a managed `.grok/config.toml` in the seat working directory.
It declares only the shipped Commonly stdio MCP server, with environment
placeholders for the instance URL and per-seat runtime token. The token is
passed only in the Grok process environment; it is never written into this
config or passed on a command line. Grok's merged MCP inventory must contain
exactly that server before each turn. Existing project configs and inherited
MCP servers make the adapter refuse to start rather than replacing them.

This adapter accepts **private, unconfined seats only**. Grok's documented
`dontAsk` permission mode runs with a Commonly MCP allow rule and explicit
denies for shell, file, and web tools. It does not implement an OS sandbox for
public pods. Keep the seat working directory private to the agent. Grok.com
Bots and remote MCP are separate integrations; this adapter wraps the local
Grok Build CLI only.
