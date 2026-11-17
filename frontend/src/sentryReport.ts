// The eager half of error-boundary reporting. sentry.ts statically imports
// @sentry/react and is the lazy chunk, so this file must never import it
// statically (sentry.test.ts guards that). Components import this file only.

type ErrorBoundaryName = 'app' | 'v2';

interface BoundaryReport {
  boundary: ErrorBoundaryName;
  componentStack?: string | null;
}

// The free tier is 5,000 events a month, and a crash loop can spend that in a
// day: one report per message per boundary per session, five per page load.
const MAX_REPORTS_PER_LOAD = 5;
const MAX_REMEMBERED = 50;
const SEEN_KEY = 'commonly.boundaryReports';

let reportsThisLoad = 0;
const seenThisLoad = new Set<string>();

// sessionStorage outlives the page, so it holds a hash: never the message, which
// can quote a token.
const hashText = (text: string): string => {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) % 0x7fffffff;
  }
  return hash.toString(36);
};

const readSeen = (): string[] => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const rememberSeen = (seen: string[]): void => {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-MAX_REMEMBERED)));
  } catch {
    // Storage blocked: seenThisLoad still dedupes within the page.
  }
};

// Claimed in memory before the chunk loads, so two crashes in flight can't both
// pass. The session record is written only once the report is captured: a page
// that unloads while the chunk loads (a reload after a failed lazy chunk, F541)
// must not leave a record for a report that never went out, or the next load
// would skip it.
const claimReport = (error: unknown, boundary: ErrorBoundaryName): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${boundary}:${hashText(message)}`;
  if (seenThisLoad.has(key) || readSeen().includes(key)) return null;
  if (reportsThisLoad >= MAX_REPORTS_PER_LOAD) return null;
  reportsThisLoad += 1;
  seenThisLoad.add(key);
  return key;
};

// Always resolves: a failed report stays silent, and a failed chunk load has
// nowhere to reject to. The DSN test sits around the import, as it does in
// index.tsx, so a build with no DSN drops the chunk.
export const reportBoundaryError = async (error: unknown, report: BoundaryReport): Promise<void> => {
  try {
    if (process.env.REACT_APP_SENTRY_DSN) {
      const key = claimReport(error, report.boundary);
      if (key) {
        const { captureBoundaryError } = await import('./sentry');
        captureBoundaryError(error, report);
        rememberSeen([...readSeen(), key]);
      }
    }
  } catch {
    // Nothing to do: the boundary has already rendered its fallback.
  }
};
