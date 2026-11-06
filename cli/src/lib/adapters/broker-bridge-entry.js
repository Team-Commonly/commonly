/**
 * The stdio server a harness runs to reach the grant broker (F175b, F175d).
 *
 * Codex, Qwen and Goose can't hold the broker's bearer token in an HTTP entry
 * without putting it somewhere the rule forbids: Codex reads it from an env
 * var, Qwen sends `--mcp-config` headers literally, and Goose fills a header
 * from its own environment or a literal in the recipe (measured on Qwen 0.26.2
 * and Goose 1.54.0). So each runs our bridge (codex-broker-bridge.mjs), told
 * the broker's url, its headers as templates and the path of this spawn's
 * credential file. None of those is a secret. The token stays in that one file,
 * and the bridge reads it for each request.
 *
 * Whether a seat may hold the broker at all was decided before the adapter
 * (grant-broker-guard.js). This decides whether THIS entry can be wired, and a
 * command the entry declares is never run.
 */
import {
  BRIDGE_HEADERS_VAR, BRIDGE_PATH, BRIDGE_URL_VAR, CREDENTIAL_FILE_VAR,
} from './codex-broker-bridge.mjs';

// A server name becomes a config key or a tool-name prefix.
export const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
// What fetch accepts in a header: Latin-1, no CR, LF or NUL.
// eslint-disable-next-line no-control-regex
const HEADER_TEXT = /^[^\r\n\0Ā-￿]*$/;
const INSTANCE_PLACEHOLDER = /\$\{(?:COMMONLY_API_URL|COMMONLY_INSTANCE_URL)\}/g;

/**
 * `{ command, args, env, readPath }`, or `{ skip }` with why it can't be wired.
 * `readPath` is the one file a jailed seat must be able to read: the bridge
 * imports node builtins only.
 */
export const brokerBridgeEntry = (server, { instanceUrl, credentialFile, runtimeToken } = {}) => {
  if (!SERVER_NAME.test(server?.name || '')) return { skip: 'its name is not a plain config key' };
  if (!credentialFile) return { skip: 'there is no seat credential to read' };
  // Resolve the instance placeholders only: the token placeholder stays in the
  // header template and is filled by the bridge from the file.
  const resolve = (value) => String(value).replace(INSTANCE_PLACEHOLDER, (whole) => instanceUrl || whole);
  const resolvedUrl = resolve(server.url);
  const headers = Object.fromEntries(Object.entries(server.headers || {})
    .map(([name, value]) => [String(name), resolve(String(value))]));
  const carriesToken = (value) => !!runtimeToken && value.includes(runtimeToken);
  if (carriesToken(resolvedUrl)
    || Object.entries(headers).some(([name, value]) => carriesToken(name) || carriesToken(value))) {
    return { skip: 'the entry holds the seat token as a literal, which would ride a config' };
  }
  if (resolvedUrl.includes('${')) return { skip: 'its url holds a placeholder this host cannot resolve' };
  // A header fetch would reject quotes its value in the error, and that value
  // holds the token once the bridge fills it, so such an entry is not wired.
  if (Object.entries(headers).some(([name, value]) => !HEADER_TEXT.test(name) || !HEADER_TEXT.test(value))) {
    return { skip: 'a header holds a control or non-Latin-1 character' };
  }
  // The url the guard judged (isOurGrantBroker) is normalised: resolved against
  // the instance, with doubled slashes collapsed. The bridge fetches that same
  // url, on the instance's own origin, or nothing.
  let url;
  try {
    const instance = new URL(instanceUrl);
    const parsed = new URL(resolvedUrl, instance);
    if (parsed.origin !== instance.origin) return { skip: 'its url is not on this instance' };
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    url = parsed.href;
  } catch {
    return { skip: 'its url does not resolve against this instance' };
  }
  return {
    command: process.execPath,
    args: [BRIDGE_PATH],
    env: {
      [BRIDGE_URL_VAR]: url,
      [BRIDGE_HEADERS_VAR]: JSON.stringify(headers),
      [CREDENTIAL_FILE_VAR]: credentialFile,
    },
    readPath: BRIDGE_PATH,
  };
};
