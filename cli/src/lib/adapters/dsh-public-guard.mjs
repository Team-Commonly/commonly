/**
 * F115: the dsh plugin a public seat's turn loads. The adapter copies this file
 * into the turn's own folder and names it in the --patch; it is never read from
 * anywhere a seat or a stranger can write.
 *
 * It refuses every tool call except a Commonly MCP tool that the adapter did not
 * withhold. A tool a future dsh adds is refused too, without a code change.
 * It also provides the service the Commonly MCP entry is gated on: if this file
 * fails to load, the MCP never starts, so the turn has no tools at all rather
 * than unguarded ones.
 *
 * Self-contained on purpose: it runs inside dsh and imports nothing.
 * dsh.js holds the service name as DSH_PUBLIC_GUARD_SERVICE; a test holds them equal.
 */
export const name = 'commonly-public-guard';
export const inject = ['tools'];

const PREFIX = 'mcp__commonly__';

export function apply(ctx, config) {
  if (!Array.isArray(config?.withheld)) throw new Error('commonly-public-guard: config.withheld is required');
  const withheld = new Set(config.withheld.map(String));
  ctx.provide('commonlyPublicGuard', Object.freeze({ withheld: [...withheld] }));
  ctx.tools.guard((exec) => {
    const tool = typeof exec?.name === 'string' ? exec.name : '';
    const raw = tool.startsWith(PREFIX) ? tool.slice(PREFIX.length) : '';
    if (raw && !withheld.has(raw)) return undefined;
    return `${tool || 'This tool'} is not available on a public seat`;
  });
}
