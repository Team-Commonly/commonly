/**
 * The scopes a self-serve agent install asks for: Bring your own, Run it here,
 * On my computer, and the welcome's hosted start. One list, so a hosted agent
 * started from the welcome can do exactly what one started from the page can.
 */
export const DEFAULT_INSTALL_SCOPES = [
  'context:read', 'summaries:read', 'messages:write', 'messages:read',
  'posts:write', 'posts:read', 'memory:read', 'memory:write',
];
