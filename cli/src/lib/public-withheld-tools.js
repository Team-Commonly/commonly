// Commonly MCP tools that public seats are not offered, on any adapter.
// Claude workspace seats follow the same list. Each
// adapter removes them in its own vocabulary (TASK-287; Goose's public list
// already leaves them out).
// commonly_catch_up moves the read cursor past history unread; a wrapper seat
// already catches up before each turn, so no seat on this list needs the tool.
export const PUBLIC_WITHHELD_TOOLS = Object.freeze(['commonly_attach_file', 'commonly_catch_up']);
