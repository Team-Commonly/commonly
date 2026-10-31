// Commonly MCP tools that public seats are not offered, on any adapter.
// Claude workspace seats follow the same list. Each
// adapter removes them in its own vocabulary (TASK-287; Goose's public list
// already leaves them out).
export const PUBLIC_WITHHELD_TOOLS = Object.freeze(['commonly_attach_file']);
