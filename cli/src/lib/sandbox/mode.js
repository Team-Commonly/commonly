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
 * derived default is 'workspace' everywhere, except the Windows microVM opt-in
 * (resolveCodexSandboxMode below).
 *
 * Native Windows, opt-in: with COMMONLY_SANDBOX_MICROVM=1 in the host process,
 * an undeclared mode on win32 resolves to 'microvm' (a microsandbox microVM,
 * sandbox/microsandbox.js). This is the only place that reads the flag. Without
 * it win32 resolves exactly as before, to 'bwrap', which attach then refuses.
 * 'microvm' is host-resolved and never stored: environment.js does not accept it
 * as a declared mode.
 *
 * A `workspace` trust (TASK-294) resolves the same way: it is confined by the
 * same host mechanism and differs only in what the policy inside allows. The
 * grant-broker guard still reads the trust itself, not this mode, so resolving
 * it here does not make a workspace seat eligible for a room grant.
 */
import { effectiveSandboxTrust } from '../environment.js';
import { microvmFlagOn } from './microsandbox.js';

export const PUBLIC_SANDBOX_MODES = new Set(['workspace', 'read-only']);

const HOST_CONFINED_TRUSTS = new Set(['public', 'workspace']);

export const resolvePublicSandboxMode = (sandbox, platform = process.platform, env = process.env) => {
  const declared = sandbox?.mode;
  if (!HOST_CONFINED_TRUSTS.has(effectiveSandboxTrust(sandbox?.trust))) return declared;
  if (declared !== undefined && declared !== null) return declared;
  if (platform === 'darwin') return 'workspace';
  if (platform === 'win32' && microvmFlagOn(env)) return 'microvm';
  return 'bwrap';
};

/**
 * The codex adapter's mode. Codex's `workspace` and `read-only` are read vs
 * write access inside its own permission profile, not host mechanisms, so a
 * public seat keeps whichever it declared (`workspace` when it declared none)
 * on every host but one: native Windows with COMMONLY_SANDBOX_MICROVM=1. There
 * a public Codex seat resolves to 'microvm' whatever it declared, because the
 * only other confinement on that host is Codex's own Windows sandbox, which
 * cannot enforce a public profile's read denies (host-check.js). Reading a
 * declared mode as "use Codex's own sandbox" would hand the seat to a sandbox
 * that refuses it, or worse; reading it as microvm only ever narrows it: the
 * VM mounts the workspace read-only, so `workspace` runs as `read-only`.
 *
 * Any other trust returns null (no public profile). Codex refuses `workspace`
 * trust itself (environment.js refuseWorkspaceTrust). Flag off, nothing moves.
 */
export const resolveCodexSandboxMode = (sandbox, platform = process.platform, env = process.env) => {
  if (effectiveSandboxTrust(sandbox?.trust) !== 'public') return null;
  if (platform === 'win32' && microvmFlagOn(env)) return 'microvm';
  return sandbox?.mode ?? 'workspace';
};

export default { PUBLIC_SANDBOX_MODES, resolveCodexSandboxMode, resolvePublicSandboxMode };
