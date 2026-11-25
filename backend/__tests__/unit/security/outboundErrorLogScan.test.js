/**
 * F627 guard: a file that makes credentialed outbound HTTP calls must not log a
 * whole error object. An AxiosError prints its `config` (request headers with
 * `Authorization: Bot <token>` / `Bearer <key>`, plus the URL and its query),
 * so `console.error('x failed:', error)` leaks the credential into the logs.
 *
 * Rule: in routes/, services/, controllers/, integrations/ and middleware/, any
 * "outbound" file fails when a console.error/warn/log call has ANY argument that
 * is a bare `error` / `err` / `e` / `erro` identifier, ends in `|| <that
 * identifier>` (`err?.response?.data || err` still prints the whole error), or
 * carries it as `{ error }` shorthand. Log `describeError(err)` (or call
 * `logOutboundFailure`) from utils/safeErrorLog instead.
 *
 * Outbound file: imports axios, writes an outbound credential header literal, or
 * imports one of OUTBOUND_WRAPPERS (it then logs errors those wrappers throw).
 *
 * Allow marker, on the call's first or last line, when the error can only come
 * from a DB or validation step:   // safe-log: no outbound call
 */
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '../../..');
const ROOTS = ['routes', 'services', 'controllers', 'integrations', 'middleware'];
const BARE = new Set(['error', 'err', 'e', 'erro']);
const ALLOW = 'safe-log: no outbound call';

const IMPORTS_AXIOS = /(?:require\(\s*['"]axios['"]\s*\)|from\s+['"]axios['"])/;
const CREDENTIAL_HEADER = /(?:Authorization['"]?\s*[:=]\s*[`'"](?:Bearer|Bot|Basic)\b|['"](?:x-api-key|x-goog-api-key)['"]\s*:)/;
// Modules that make a credentialed outbound call and let the raw AxiosError
// escape to their callers (the config holds the Authorization header, or for
// emailService the api_key in the request body). A file that imports one of
// these logs what it throws, so it is scanned even without its own axios import.
const OUTBOUND_WRAPPERS = [
  'llmService', 'emailService', 'discordService', 'discordCommandService',
  'githubAppService', 'xProvider', 'groupmeService', 'vectorSearchService',
  'agentAvatarService', 'slackApi', 'webSearchService', 'litellmBudgetAlarmService',
  // Callers of llmService that rethrow what it throws.
  'summarizerService', 'chatSummarizerService', 'integrationSummaryService',
  // Axios importers the file-level axios check missed.
  'oauthController', 'instagramProvider', 'discordBridgeService',
  'discordRelayCommandService', 'slackOAuthService', 'telegramService',
];
const IMPORTS_WRAPPER = new RegExp(
  `(?:require\\(\\s*|from\\s+|import\\(\\s*)['"][^'"]*/(?:${OUTBOUND_WRAPPERS.join('|')})['"]`,
);
const CONSOLE_CALL = /console\.(?:error|warn|log)\(/g;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return /\.(ts|js)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : [];
});

// Returns the text between the call's parentheses, skipping quoted strings.
const callBody = (text, open) => {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '\'' || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i };
    }
  }
  return null;
};

// Every top-level argument of a call body.
const splitArgs = (body) => {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '\'' || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(body.slice(start).trim());
  return args.filter(Boolean);
};
// A bare identifier, a fallback chain that ends in one (`x?.response?.data || err`),
// or the shorthand `{ error }` / `{ err, other }` that prints the whole error.
const SHORTHAND = /[{,]\s*(?:error|err|e|erro)\s*(?=[,}])/;
const printsWholeError = (arg) => BARE.has(arg)
  || BARE.has((arg.split(/\|\||\?\?/).pop() || '').trim())
  || (arg.startsWith('{') && SHORTHAND.test(arg));

const findViolations = (text) => {
  const lines = text.split('\n');
  const violations = [];
  CONSOLE_CALL.lastIndex = 0;
  let match = CONSOLE_CALL.exec(text);
  while (match) {
    const open = match.index + match[0].length - 1;
    const call = callBody(text, open);
    if (call && splitArgs(call.body).some(printsWholeError)) {
      const first = text.slice(0, match.index).split('\n').length;
      const last = text.slice(0, call.end).split('\n').length;
      const allowed = (lines[first - 1] + lines[last - 1]).includes(ALLOW);
      if (!allowed) violations.push(`line ${first}: ${lines[first - 1].trim()}`);
    }
    match = CONSOLE_CALL.exec(text);
  }
  return violations;
};

const isOutboundFile = (text) => IMPORTS_AXIOS.test(text) || CREDENTIAL_HEADER.test(text) || IMPORTS_WRAPPER.test(text);

describe('outbound error logging guard (F627)', () => {
  const files = ROOTS.flatMap((root) => {
    const dir = path.join(BACKEND, root);
    return fs.existsSync(dir) ? walk(dir) : [];
  });

  it('treats a file importing an outbound wrapper as outbound', () => {
    expect(isOutboundFile("const { generateText } = require('./llmService');")).toBe(true);
    expect(isOutboundFile("import { sendEmail } from '../services/emailService';")).toBe(true);
    expect(isOutboundFile("const x = require('./podService');")).toBe(false);
  });

  it('scans a real set of files', () => {
    expect(files.length).toBeGreaterThan(100);
    const outbound = files.filter((f) => isOutboundFile(fs.readFileSync(f, 'utf8')));
    expect(outbound.length).toBeGreaterThan(10);
  });

  it('flags a bare error argument and honours the allow marker', () => {
    expect(findViolations("console.error('x failed:', error);")).toHaveLength(1);
    expect(findViolations("console.warn(`x ${a(b)} failed`,\n  err,\n);")).toHaveLength(1);
    expect(findViolations("console.error('x failed:', err?.response?.data || err);")).toHaveLength(1);
    expect(findViolations("console.error('x failed:', e.response?.data || e.message);")).toHaveLength(0);
    expect(findViolations("console.error('x failed:', error.message);")).toHaveLength(0);
    // any argument, not only the last
    expect(findViolations("console.error('x %s failed:', error, String(id));")).toHaveLength(1);
    // { error } shorthand
    expect(findViolations("console.error('x failed', { error });")).toHaveLength(1);
    expect(findViolations("console.error('x failed', { podId, err });")).toHaveLength(1);
    expect(findViolations("console.error('x failed', { error: error.message });")).toHaveLength(0);
    expect(findViolations("console.error('x failed:', describeError(error));")).toHaveLength(0);
    expect(findViolations(`console.error('db failed:', error); // ${ALLOW}`)).toHaveLength(0);
  });

  it('no credentialed outbound file logs a whole error object', () => {
    const offenders = [];
    files.forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      if (!isOutboundFile(text)) return;
      findViolations(text).forEach((v) => offenders.push(`${path.relative(BACKEND, file)} ${v}`));
    });
    expect(offenders).toEqual([]);
  });
});
