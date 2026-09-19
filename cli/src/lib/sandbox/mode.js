/**
 * Which host mechanism enforces a public seat.
 *
 * A stored environment is platform-independent and the host is not. The daemon
 * derives `sandbox: { trust: 'public' }` with NO mode (lib/default-environment.js)
 * because `mode: 'workspace'` is Seatbelt on macOS and is refused on Linux,
 * while `mode: 'bwrap'` is meaningless on macOS — writing either into the row
 * moves a host fact into the database and breaks the day the seat is re-homed
 * (Wren 69545).
 *
 * So the mode is resolved here, at the point that knows the host:
 *   darwin  → 'workspace' (the claude adapter maps it to Seatbelt)
 *   else    → 'bwrap'     (bubblewrap; attach checks it is installed)
 *
 * Resolution is PUBLIC-only on purpose. A non-public declaration keeps whatever
 * mode it wrote, and an adapter that cannot enforce it is expected to refuse
 * rather than quietly spawn unconfined. An explicit mode on a public
 * declaration still wins — including a wrong one, which the caller then
 * refuses (Vera 69548: an unresolvable public mode must not fall through to a
 * bare, unconfined spawn).
 *
 * NOT used by the codex adapter. Codex's `mode` is read-vs-write access, not a
 * host mechanism — its permission profiles run on both platforms — so its
 * derived default is 'workspace' everywhere.
 */

export const PUBLIC_SANDBOX_MODES = new Set(['workspace', 'read-only']);

export const resolvePublicSandboxMode = (sandbox, platform = process.platform) => {
  const declared = sandbox?.mode;
  if (sandbox?.trust !== 'public') return declared;
  if (declared !== undefined && declared !== null) return declared;
  return platform === 'darwin' ? 'workspace' : 'bwrap';
};

export default { PUBLIC_SANDBOX_MODES, resolvePublicSandboxMode };
