/**
 * macOS Seatbelt wrapper for public local-CLI agents.
 *
 * `sandbox-exec` is deprecated as a public API, but remains the host-native
 * kernel boundary available to local CLI wrappers on current macOS. This
 * profile starts from deny-by-default, admits only the system runtime the CLI
 * needs, and then grants explicit access to:
 *   - the selected CLI executable,
 *   - one workspace (read/write or read-only),
 *   - one isolated state directory, and
 *   - the adapter-owned transient MCP config directory (read-only).
 *
 * The static platform baseline is adapted from OpenAI Codex's Apache-2.0
 * Seatbelt policy:
 * https://github.com/openai/codex/tree/main/codex-rs/sandboxing/src
 *
 * Public seats still need outbound network access for their provider API and
 * declared MCP transports. Host confidentiality therefore comes from the
 * filesystem boundary, not a claim that all network syscalls are disabled.
 */

import { spawnSync } from 'child_process';
import { lstatSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const DARWIN_MESSAGE = 'Seatbelt sandboxing is available only on macOS';

// Keep this baseline static and auditable. Dynamic paths are appended by
// buildSeatbeltProfile after strict absolute-path validation + SBPL escaping.
const PLATFORM_BASELINE = String.raw`
(version 1)
(deny default)

; Children inherit the same sandbox. Process inspection is limited to this
; sandbox, so a model cannot inspect unrelated operator processes.
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; Loader + standard system resources.
(allow file-read* file-test-existence
  (subpath "/Library/Apple")
  (subpath "/Library/Filesystems/NetFSPlugins")
  (subpath "/Library/Preferences/Logging")
  (subpath "/private/var/db/DarwinDirectory/local/recordStore.data")
  (subpath "/private/var/db/timezone")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/Library/Preferences")
  (subpath "/var/db")
  (subpath "/private/var/db"))
(allow file-read* file-test-existence
  (subpath "/System/Volumes/Preboot/Cryptexes/OS"))

(allow file-map-executable
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/System/Library/Extensions")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/System/iOSSupport/System/Library/Frameworks")
  (subpath "/System/iOSSupport/System/Library/PrivateFrameworks")
  (subpath "/System/iOSSupport/System/Library/SubFrameworks")
  (subpath "/usr/lib"))

(allow file-read* file-test-existence
  (subpath "/Library/Apple/System/Library/Frameworks")
  (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/Library/Apple/usr/lib")
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/System/Library/SubFrameworks")
  (subpath "/System/iOSSupport/System/Library/Frameworks")
  (subpath "/System/iOSSupport/System/Library/PrivateFrameworks")
  (subpath "/System/iOSSupport/System/Library/SubFrameworks")
  (subpath "/usr/lib"))

(allow system-mac-syscall (mac-policy-name "vnguard"))
(allow system-mac-syscall
  (require-all
    (mac-policy-name "Sandbox")
    (mac-syscall-number 67)))

(allow file-read-metadata file-test-existence
  (literal "/etc")
  (literal "/tmp")
  (literal "/var")
  (literal "/private/etc/localtime")
  (path-ancestors "/System/Volumes/Data/private"))
(allow file-read* file-test-existence (literal "/"))

(allow file-read* file-test-existence
  (literal "/dev/autofs_nowait")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "/private/etc/master.passwd")
  (literal "/private/etc/passwd")
  (literal "/private/etc/protocols")
  (literal "/private/etc/services"))
(allow file-read* file-test-existence file-write-data file-ioctl
  (literal "/dev/dtracehelper"))
(allow file-read* file-test-existence file-write-data file-ioctl
  (literal "/dev/null")
  (literal "/dev/zero"))
(allow file-read-data file-test-existence file-write-data (subpath "/dev/fd"))

; System configuration is readable; user-home configuration is not.
(allow file-read* (subpath "/etc"))
(allow file-read* (subpath "/private/etc"))
(allow file-read* file-test-existence
  (literal "/System/Library/CoreServices")
  (literal "/System/Library/CoreServices/.SystemVersionPlatform.plist")
  (literal "/System/Library/CoreServices/SystemVersion.plist"))
(allow file-read-metadata file-test-existence
  (literal "/Library")
  (literal "/Library/Application Support")
  (literal "/System/Library")
  (literal "/System/Cryptexes")
  (literal "/System/Cryptexes/App")
  (literal "/System/Cryptexes/OS"))
(allow file-read-metadata (subpath "/var"))
(allow file-read-metadata (subpath "/private/var"))

; The wrapper and declared MCP launchers may execute children. Claude
; bootstraps stdio MCP servers through /bin/sh, whose interpreter is /bin/bash
; on current macOS. An executable-level shell deny would therefore disable
; declared MCP capability too. Each adapter denies its built-in shell tool in
; its own config; any declared child inherits this Seatbelt profile.

(allow file-read-data file-read-metadata (subpath "/bin"))
(allow file-read-data file-read-metadata (subpath "/sbin"))
(allow file-read-data file-read-metadata (subpath "/usr/bin"))
(allow file-read-data file-read-metadata (subpath "/usr/sbin"))
(allow file-read-data file-read-metadata (subpath "/usr/libexec"))
(allow file-read* file-test-existence (subpath "/opt/homebrew/bin"))
(allow file-read* file-test-existence file-map-executable
  (subpath "/opt/homebrew/Cellar"))
(allow file-read* file-test-existence
  (subpath "/opt/homebrew/etc/openssl@3"))
; openssl@3/cert.pem resolves to this Homebrew CA bundle. Seatbelt checks the
; target path, so the openssl@3 directory grant alone does not admit TLS roots.
(allow file-read* file-test-existence
  (literal "/opt/homebrew/etc/ca-certificates/cert.pem"))
(allow file-read* (subpath "/opt/homebrew/lib"))
(allow file-read* file-test-existence file-map-executable
  (subpath "/opt/homebrew/opt"))
(allow file-read* file-test-existence (subpath "/usr/local/bin"))
(allow file-read* (subpath "/usr/local/lib"))

; Standard device handles and PTY support.
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
(allow file-read* (regex "^/dev/fd/(0|1|2)$"))
(allow file-write* (regex "^/dev/fd/(1|2)$"))
(allow file-read* file-write* (literal "/dev/tty"))
(allow file-read-metadata (literal "/dev"))
(allow file-read-metadata (regex "^/dev/.*$"))
(allow file-read-metadata (literal "/dev/stdin"))
(allow file-read-metadata (literal "/dev/stdout"))
(allow file-read-metadata (literal "/dev/stderr"))

; Runtime queries used by native binaries and Node/Bun.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.ephemeral_storage")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.model")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.bootargs")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.iossupportversion")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "security.mac.lockdown_mode_state")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))

(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-data
  (ipc-posix-name "com.apple.AppleDatabaseChanged"))
(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow ipc-posix-shm-read*
  (ipc-posix-name "apple.shm.notification_center"))
(allow mach-lookup
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.analyticsd")
  (global-name "com.apple.analyticsd.messagetracer")
  (global-name "com.apple.appsleep")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.FSEvents")
  (global-name "com.apple.logd")
  (global-name "com.apple.logd.events")
  (global-name "com.apple.runningboard")
  (global-name "com.apple.secinitd")
  (global-name "com.apple.system.DirectoryService.libinfo_v1")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.trustd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.xpc.activity.unmanaged")
  (local-name "com.apple.cfprefsd.agent"))
; cfprefsd serves a sandboxed client a preference domain only when this
; profile admits user-preference-read for that domain (or file-read-data on
; its plist, which HOME never gets). An unfiltered rule hands a confined agent
; every app's domain in ~/Library/Preferences. Admit only the global domain
; (.GlobalPreferences: locale, languages, units). It is the one domain a
; sandboxed tool was measured requesting: /usr/bin/security, which Claude
; runs to read its Keychain credential. Node, OpenCode and Qwen request none.
; Apple's App Sandbox grants every app this same domain.
(allow user-preference-read
  (preference-domain "kCFPreferencesAnyApplication"))
`;

// Open network, the tail of the default baseline. A `network: 'loopback'`
// profile leaves it out: no outbound except the loopback ports it lists, and
// none of the Security framework services the keychain is reached through.
const OPEN_NETWORK = String.raw`
; The selected provider and declared MCP transports need outbound network. The model's
; WebSearch/WebFetch/Bash tools are denied independently in the adapter argv.
(allow network-outbound)
(allow system-socket
  (require-all
    (socket-domain AF_SYSTEM)
    (socket-protocol 2)))
(allow mach-lookup
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.securityd")
  (global-name "com.apple.securityd.xpc"))
`;

// Both network modes. On macOS, c-ares (node's dns.Resolver and dns.resolve*)
// reads the resolver list from configd's DNSConfiguration service while the
// Resolver is constructed. Denied, that lookup does not always fail: at
// times it blocks the main thread forever. dsh builds a Resolver as it loads,
// so confined turns ran to their 900 s timeout without sending a request
// Admitted, resolution fails fast, because mDNSResponder and port 53
// stay unreachable in a loopback profile. The service returns configuration
// and opens no channel out.
const RESOLVER_CONFIG = String.raw`
(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration"))
`;

const escapeSbplString = (value) => String(value)
  .replaceAll('\\', '\\\\')
  .replaceAll('"', '\\"')
  .replaceAll('\n', '\\n')
  .replaceAll('\r', '\\r');

const literal = (path) => `(literal "${escapeSbplString(path)}")`;
const subpath = (path) => `(subpath "${escapeSbplString(path)}")`;
// Every .env and .env.* file under the workspace, at any depth, and everything
// inside a directory of that name: a real project keeps one beside each
// package, not only at its root (TASK-294). An SBPL regex literal takes no
// escapes, so a path it cannot hold is refused.
const envFilesUnder = (workspace) => {
  if (/["\r\n]/.test(workspace)) {
    throw new Error('Seatbelt workspacePath must not contain a quote or a line break');
  }
  const pattern = workspace.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
  return `(regex #"^${pattern}/(.*/)?\\.env([./].*)?$")`;
};

const assertAbsolutePath = (path, label) => {
  if (!path || !isAbsolute(path)) {
    throw new Error(`Seatbelt ${label} must be an absolute path`);
  }
};

const realpathOrSelf = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const isSymlink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

export const detectSeatbelt = () => {
  if (process.platform !== 'darwin') {
    return { available: false, error: DARWIN_MESSAGE };
  }
  try {
    const result = spawnSync(
      SANDBOX_EXEC,
      ['-p', '(version 1)(allow default)', '/usr/bin/true'],
      { encoding: 'utf8' },
    );
    if (result.error || result.status !== 0) {
      return {
        available: false,
        error: `sandbox-exec preflight failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`,
      };
    }
    return { available: true, path: SANDBOX_EXEC };
  } catch (err) {
    return { available: false, error: `sandbox-exec detection failed: ${err.message}` };
  }
};

export const buildSeatbeltProfile = ({
  workspacePath,
  workspaceAccess = 'write',
  executablePath,
  statePath,
  mcpConfigDir = null,
  executablePaths = [],
  readOnlyPaths = [],
  readOnlyDirectories = [],
  loopbackNetworkPorts = [],
  allowClaudeRuntimeAccess = false,
  // 'open' (the default) or 'loopback': only the listed loopback ports.
  network = 'open',
  // Names directly inside a writable workspace that stay read-only. A
  // workspace seat granted write keeps its project's .git read-only, so every
  // change it makes is one `git status` shows the person (TASK-294).
  readOnlyWorkspaceEntries = [],
}) => {
  for (const [path, label] of [
    [workspacePath, 'workspacePath'],
    [executablePath, 'executablePath'],
    [statePath, 'statePath'],
  ]) {
    assertAbsolutePath(path, label);
  }
  if (mcpConfigDir) assertAbsolutePath(mcpConfigDir, 'mcpConfigDir');
  for (const path of readOnlyPaths) assertAbsolutePath(path, 'readOnlyPaths entry');
  for (const path of readOnlyDirectories) assertAbsolutePath(path, 'readOnlyDirectories entry');
  for (const port of loopbackNetworkPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Seatbelt loopbackNetworkPorts entries must be valid TCP ports');
    }
  }
  if (!['open', 'loopback'].includes(network)) {
    throw new Error('Seatbelt network must be open or loopback');
  }
  if (!['read', 'write'].includes(workspaceAccess)) {
    throw new Error('Seatbelt workspaceAccess must be read or write');
  }
  for (const entry of readOnlyWorkspaceEntries) {
    if (typeof entry !== 'string' || !entry || entry.includes('/') || entry === '.' || entry === '..') {
      throw new Error('Seatbelt readOnlyWorkspaceEntries entries must be names inside the workspace');
    }
  }

  const resolvedWorkspace = realpathOrSelf(workspacePath);
  const resolvedExecutable = realpathOrSelf(executablePath);
  const resolvedState = realpathOrSelf(statePath);
  const resolvedMcpConfig = mcpConfigDir ? realpathOrSelf(mcpConfigDir) : null;
  const resolvedReadOnlyPaths = [...new Set(readOnlyPaths.map(realpathOrSelf))];
  const resolvedReadOnlyDirectories = [...new Set(readOnlyDirectories.map(realpathOrSelf))];
  const executables = [...new Set(
    [resolvedExecutable, process.execPath, ...executablePaths]
      .filter(Boolean)
      .map(realpathOrSelf),
  )];
  for (const executable of executables) {
    assertAbsolutePath(executable, 'executable path');
  }

  const workspaceRule = workspaceAccess === 'write'
    ? `(allow file-read* file-test-existence file-write* ${subpath(resolvedWorkspace)})`
    : `(allow file-read* file-test-existence ${subpath(resolvedWorkspace)})`;
  const executableRules = executables.map((executable) => [
    `(allow file-read* file-test-existence file-map-executable ${literal(executable)})`,
    `(allow file-read-metadata file-test-existence (path-ancestors "${escapeSbplString(executable)}"))`,
  ].join('\n')).join('\n');
  const executableSymlinkRules = isSymlink(executablePath) ? [
    `(allow file-read* file-test-existence ${literal(executablePath)})`,
    `(allow file-read-metadata file-test-existence (path-ancestors "${escapeSbplString(executablePath)}"))`,
  ].join('\n') : '';
  const mcpRule = resolvedMcpConfig
    ? `(allow file-read* file-test-existence ${subpath(resolvedMcpConfig)})`
    : '';
  const readOnlyRules = resolvedReadOnlyPaths.map((path) => (
    `(allow file-read* file-test-existence ${literal(path)})`
  )).concat(resolvedReadOnlyDirectories.map((path) => [
    `(allow file-read* file-test-existence ${subpath(path)})`,
    `(allow file-read-metadata file-test-existence (path-ancestors "${escapeSbplString(path)}"))`,
  ].join('\n'))).join('\n');
  // A symlinked entry is held at both its name and its target, so the write
  // cannot land through whichever path the link resolves to.
  const readOnlyWorkspaceRules = [...new Set(readOnlyWorkspaceEntries.flatMap((entry) => {
    const entryPath = join(resolvedWorkspace, entry);
    return [entryPath, realpathOrSelf(entryPath)];
  }))].map((path) => `(deny file-write* ${subpath(path)})`).join('\n');
  const loopbackNetworkRules = [...new Set(loopbackNetworkPorts)].map((port) => (
    `(allow network-outbound (remote tcp "localhost:${port}"))`
  )).join('\n');
  const claudeRuntimeRules = allowClaudeRuntimeAccess ? (() => {
    // Claude's temp root is the seat's own: the adapter sets CLAUDE_CODE_TMPDIR
    // under statePath, which the state rule above already admits. The
    // uid-wide /private/tmp/claude-<uid> holds every other Claude session's
    // temp files on the machine, so it is not admitted.
    // Claude's security helper needs the encrypted login-keychain database and
    // this non-secret locale file: that one file, not the Keychains folder.
    const loginKeychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
    const textEncoding = join(homedir(), '.CFUserTextEncoding');
    return [
      `(allow file-read* file-test-existence ${literal(loginKeychain)} ${literal(textEncoding)})`,
      `(allow file-read-metadata file-test-existence (path-ancestors "${escapeSbplString(loginKeychain)}"))`,
    ];
  })() : [];

  return [
    `${PLATFORM_BASELINE}${RESOLVER_CONFIG}${network === 'open' ? OPEN_NETWORK : ''}`.trim(),
    executableRules,
    executableSymlinkRules,
    `(allow file-read-metadata file-test-existence (path-ancestors "${escapeSbplString(resolvedWorkspace)}"))`,
    `(allow file-read-metadata file-test-existence (path-ancestors "${escapeSbplString(resolvedState)}"))`,
    workspaceRule,
    `(allow file-read* file-test-existence file-write* ${subpath(resolvedState)})`,
    loopbackNetworkRules,
    mcpRule,
    readOnlyRules,
    // The workspace is intentionally readable, but credential-like nested
    // paths are not. Explicit deny wins over the broad workspace allow.
    `(deny file-read* file-write* ${subpath(join(resolvedWorkspace, '.commonly'))})`,
    `(deny file-read* file-write* ${subpath(join(resolvedWorkspace, '.codex'))})`,
    `(deny file-read* file-write* ${envFilesUnder(resolvedWorkspace)})`,
    readOnlyWorkspaceRules,
    ...claudeRuntimeRules,
  ].filter(Boolean).join('\n\n');
};

export const wrapArgvWithSeatbelt = (innerArgv, opts = {}) => {
  if (process.platform !== 'darwin') {
    throw new Error(DARWIN_MESSAGE);
  }
  if (!Array.isArray(innerArgv) || innerArgv.length === 0) {
    throw new Error('wrapArgvWithSeatbelt requires a non-empty innerArgv');
  }
  const profile = buildSeatbeltProfile(opts);
  return [SANDBOX_EXEC, '-p', profile, ...innerArgv];
};

export const publicClaudeStateRoot = (agentKey) => (
  join(homedir(), '.commonly', 'claude-homes', agentKey)
);

export const SEATBELT_DARWIN_MESSAGE = DARWIN_MESSAGE;
