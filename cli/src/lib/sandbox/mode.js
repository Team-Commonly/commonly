/**
 * Which host mechanism enforces a public seat.
 *
 * A stored environment is platform-independent and the host is not. The daemon
 * derives `sandbox: { trust: 'public' }` with NO mode (lib/default-environment.js)
 * because `mode: 'workspace'` is Seatbelt on macOS and is refused on Linux,
 * while `mode: 'bwrap'` is meaningless on macOS — writing either into the row
 * moves a host fact into the database and breaks the day the seat is re-homed.
 *
 * So the mode is resolved here, at the point that knows the host:
 *   darwin  → 'workspace' (the claude adapter maps it to Seatbelt)
 *   else    → 'bwrap'     (bubblewrap; attach checks it is installed)
 *
 * Resolution is PUBLIC-only on purpose, and PUBLIC IS THE EFFECTIVE TRUST: a
 * legacy `internal` declaration reads as `public` (environment.js),
 * so the mapping is applied before this comparison. Comparing the raw value
 * made `{ trust: 'internal' }` resolve to no mode at all — the mapping was
 * applied in `confinementReason` and not here, which is half a rule, and the
 * half that failed was the one that WITHHOLDS: the grant broker was taken from
 * a seat this daemon would have confined. A non-public declaration keeps
 * whatever mode it wrote, and an adapter that cannot enforce it is expected to
 * refuse rather than quietly spawn unconfined. An explicit mode on a public
 * declaration still wins — including a wrong one, which the caller then refuses
 * (an unresolvable public mode must not fall through to a bare,
 * unconfined spawn).
 *
 * NOT used by the codex adapter. Codex's `mode` is read-vs-write access, not a
 * host mechanism — its permission profiles run on both platforms — so its
 * derived default is 'workspace' everywhere.
 *
 * A `workspace` trust (TASK-294) resolves the same way: it is confined by the
 * same host mechanism and differs only in what the policy inside allows. The
 * grant-broker guard still reads the trust itself, not this mode, so resolving
 * it here does not make a workspace seat eligible for a room grant.
 */
import { effectiveSandboxTrust } from '../environment.js';

export const PUBLIC_SANDBOX_MODES = new Set(['workspace', 'read-only']);

const HOST_CONFINED_TRUSTS = new Set(['public', 'workspace']);

export const resolvePublicSandboxMode = (sandbox, platform = process.platform) => {
  const declared = sandbox?.mode;
  if (!HOST_CONFINED_TRUSTS.has(effectiveSandboxTrust(sandbox?.trust))) return declared;
  if (declared !== undefined && declared !== null) return declared;
  return platform === 'darwin' ? 'workspace' : 'bwrap';
};

export default { PUBLIC_SANDBOX_MODES, resolvePublicSandboxMode };
