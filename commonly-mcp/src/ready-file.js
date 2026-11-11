/**
 * Tell the CLI that this server started and its host reached it.
 *
 * A public OpenCode seat's stream says nothing about its MCP servers. When the
 * Commonly server fails to start, OpenCode logs one WARN line, runs the model
 * without the Commonly tools, and exits 0, so the CLI would post an answer the
 * model wrote without reading the pod (measured on OpenCode 1.19.0, F421). The
 * CLI therefore names a file for each spawn in `COMMONLY_MCP_READY_FILE`, and
 * this server creates it when the host's `initialize` arrives. No file after
 * the turn means the server never got that far, and the CLI withholds the turn.
 *
 * The file is created once, exclusively, mode 0600, and holds nothing secret.
 * A failure to write it goes to stderr only: stdout belongs to the transport.
 * Without the variable nothing happens, so a person's own client never sees it.
 *
 * package.json advertises this (`commonly.readyFile`), so a CLI asks for the
 * file only from a release that writes it.
 */
import { writeFileSync } from 'fs';
import { isAbsolute } from 'path';

export const READY_FILE_ENV = 'COMMONLY_MCP_READY_FILE';

export const createReadyFileWriter = (env = process.env, { write = writeFileSync, warn } = {}) => {
  const path = env?.[READY_FILE_ENV];
  let done = !path;
  return () => {
    if (done) return false;
    done = true;
    if (!isAbsolute(path)) {
      warn?.(`[commonly-mcp] ${READY_FILE_ENV} is not an absolute path; not writing it\n`);
      return false;
    }
    try {
      write(path, 'ready\n', { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      warn?.(`[commonly-mcp] could not write the ready file: ${e.code || e.message}\n`);
      return false;
    }
  };
};
