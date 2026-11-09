/**
 * The read-only `workspace_git` MCP server (git-readonly-server.js), as an
 * adapter attaches it to a sandboxed seat. Shared by the claude adapter (for a
 * workspace-trust seat) and the codex adapter (for a public seat), so both
 * give the model the same one git tool, run against the same real binary.
 */
import { spawnSync } from 'child_process';
import { realpathSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// The name git-readonly-server.js serves under. Kept here, not imported: the
// server module pulls in git-readonly.js and its execFile, which an adapter has
// no use for (git-readonly-server.test.mjs checks the two names agree).
export const WORKSPACE_GIT_SERVER_NAME = 'workspace_git';

// The server runs inside the sandbox, so the sandbox must admit its code
// (cli/src/lib, plus package.json for the module type) and the git binary it runs.
export const WORKSPACE_GIT_SERVER = fileURLToPath(new URL('./git-readonly-server.js', import.meta.url));
export const WORKSPACE_GIT_PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

// macOS's /usr/bin/git is an xcrun shim, and it fails inside a sandbox ("No
// developer tools were found"). So the sandbox gets the binary git itself runs:
// `git --exec-path`, resolved here on the host, holds a `git` that links to it.
export const resolveRealGit = ({ run = spawnSync } = {}) => {
  const result = run('git', ['--exec-path'], { encoding: 'utf8', timeout: 5000 });
  const execDir = result?.status === 0 ? String(result.stdout || '').trim() : '';
  if (!execDir) return null;
  try {
    return realpathSync(join(execDir, 'git'));
  } catch {
    return null;
  }
};

// The MCP server entry and the paths the sandbox has to let it read, for a
// seat whose workspace is `root`. Null when this machine has no git.
export const workspaceGitAttachment = (root, { git = resolveRealGit() } = {}) => {
  if (!root || !git) return null;
  return {
    server: {
      name: WORKSPACE_GIT_SERVER_NAME,
      transport: 'stdio',
      command: [process.execPath, WORKSPACE_GIT_SERVER, '--root', root, '--git', git],
    },
    executable: git,
    readDirectories: [dirname(WORKSPACE_GIT_SERVER)],
    readPaths: [WORKSPACE_GIT_PACKAGE_JSON],
  };
};
