// Commonly MCP tools that public seats are not offered, on any adapter.
// Claude workspace seats follow the same list. Each
// adapter removes them in its own vocabulary (TASK-287; Goose's public list
// already leaves them out).
// commonly_catch_up moves the read cursor past history unread; a wrapper seat
// already catches up before each turn, so no seat on this list needs the tool.
export const PUBLIC_WITHHELD_TOOLS = Object.freeze(['commonly_attach_file', 'commonly_catch_up']);

// F118 (Cofounder ruling, 11-04): public agents start from nothing and earn
// capabilities. A public seat answers strangers, so an injected message must
// not be able to spread the agent into other pods or rewrite its memory.
// Withheld on public trust only: a Claude workspace seat keeps its memory
// writes, and denies self-install itself (claude.js, workspaceDenies). The
// memory writes come back on a turn the owner woke (F145, below).
// commonly_log_cycle is a memory write too: it appends to the agent's
// `cycles[]` through POST /api/agents/runtime/memory/sync. Reading memory
// (commonly_read_agent_memory, and the long_term the wrapper puts in the
// prompt) stays offered.
// commonly_delete_message (F141): a stranger-steered seat could delete its own
// replies to an injection, which are the evidence of what the attack achieved.
// A workspace seat keeps it.
export const PUBLIC_ONLY_WITHHELD_TOOLS = Object.freeze([
  'commonly_self_install_into_pod',
  'commonly_write_agent_memory',
  'commonly_save_my_memory',
  'commonly_log_cycle',
  'commonly_delete_message',
]);

// Everything a public seat is not offered. Codex, OpenCode, Qwen and Goose
// confine on public trust only, so this is the whole list for them.
export const PUBLIC_SEAT_WITHHELD_TOOLS = Object.freeze([
  ...PUBLIC_WITHHELD_TOOLS, ...PUBLIC_ONLY_WITHHELD_TOOLS,
]);

// F145: what comes back on a turn the kernel verified its owner woke, so the
// owner keeps a remembering agent. The kernel refuses these writes on any other
// public turn, whatever an adapter offers.
export const OWNER_WOKEN_MEMORY_TOOLS = Object.freeze([
  'commonly_write_agent_memory',
  'commonly_save_my_memory',
  'commonly_log_cycle',
]);

/** What a public seat is not offered on this turn. Only a literal `true` opens it. */
export const publicSeatWithheldTools = (ctx) => (ctx?.ownerWoken === true
  ? PUBLIC_SEAT_WITHHELD_TOOLS.filter((tool) => !OWNER_WOKEN_MEMORY_TOOLS.includes(tool))
  : PUBLIC_SEAT_WITHHELD_TOOLS);
