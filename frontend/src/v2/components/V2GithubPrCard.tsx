import React, { useEffect, useState } from 'react';

// Inline GitHub PR preview rendered when a message references
// `https://github.com/<owner>/<repo>/pull/<number>`. Detection lives in
// V2MessageBubble; this component owns the fetch + render once given the
// (owner, repo, number) tuple.
//
// Fetches via the public GitHub REST API (no auth required for public
// repos). Rate limit is 60/hr per IP unauthenticated — fine for the demo
// surface; a single PR is also memoized at module scope so re-renders and
// repeat references in the same session are free.
//
// Failure mode: if the fetch errors (private repo, rate-limited, network),
// the component renders nothing and the parent's clickable URL remains —
// graceful degradation, never blocks the message bubble.

interface PrSummary {
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  number: number;
  htmlUrl: string;
  user: { login: string; avatarUrl: string };
  createdAt: string;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  contributors: { login: string; avatarUrl: string }[];
}

const cache = new Map<string, Promise<PrSummary | null>>();

async function fetchPrSummary(owner: string, repo: string, number: number): Promise<PrSummary | null> {
  const key = `${owner}/${repo}#${number}`;
  if (cache.has(key)) return cache.get(key)!;
  const promise = (async () => {
    try {
      const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
      const [prRes, commitsRes] = await Promise.all([
        fetch(base, { headers: { Accept: 'application/vnd.github+json' } }),
        fetch(`${base}/commits?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } }),
      ]);
      if (!prRes.ok) return null;
      const pr: any = await prRes.json();
      const commits: any[] = commitsRes.ok ? await commitsRes.json() : [];
      const contribMap = new Map<string, { login: string; avatarUrl: string }>();
      for (const c of commits) {
        const author = c.author || c.commit?.author;
        const login = (author?.login as string) || (c.commit?.author?.name as string) || '';
        const avatarUrl = (author?.avatar_url as string) || '';
        if (login && !contribMap.has(login)) {
          contribMap.set(login, { login, avatarUrl });
        }
      }
      return {
        title: String(pr.title || ''),
        state: pr.state === 'closed' ? 'closed' : 'open',
        merged: !!pr.merged,
        number: pr.number,
        htmlUrl: pr.html_url,
        user: {
          login: pr.user?.login || '',
          avatarUrl: pr.user?.avatar_url || '',
        },
        createdAt: pr.created_at,
        commits: pr.commits || commits.length || 0,
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changedFiles: pr.changed_files || 0,
        contributors: Array.from(contribMap.values()),
      };
    } catch (err) {
      console.warn('[V2GithubPrCard] fetch failed:', (err as Error).message);
      return null;
    }
  })();
  cache.set(key, promise);
  return promise;
}

interface V2GithubPrCardProps {
  owner: string;
  repo: string;
  number: number;
}

const V2GithubPrCard: React.FC<V2GithubPrCardProps> = ({ owner, repo, number }) => {
  const [pr, setPr] = useState<PrSummary | null | 'loading'>('loading');

  useEffect(() => {
    let alive = true;
    fetchPrSummary(owner, repo, number).then((data) => {
      if (alive) setPr(data);
    });
    return () => { alive = false; };
  }, [owner, repo, number]);

  if (pr === 'loading') {
    return (
      <a
        className="v2-prcard v2-prcard--loading"
        href={`https://github.com/${owner}/${repo}/pull/${number}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="v2-prcard__chip">PR #{number}</span>
        <span className="v2-prcard__loading-text">loading…</span>
      </a>
    );
  }

  if (!pr) {
    // Fetch failed — fall back to nothing so the bubble's clickable URL
    // is the only artifact (parent has already rendered the URL).
    return null;
  }

  const stateLabel = pr.merged ? 'Merged' : (pr.state === 'open' ? 'Open' : 'Closed');
  const stateClass = pr.merged ? 'v2-prcard__state--merged'
    : pr.state === 'open' ? 'v2-prcard__state--open'
      : 'v2-prcard__state--closed';

  const visibleContributors = pr.contributors.slice(0, 4);
  const overflowCount = Math.max(0, pr.contributors.length - visibleContributors.length);

  return (
    <a
      className="v2-prcard"
      href={pr.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Pull request #${pr.number}: ${pr.title}`}
    >
      <div className="v2-prcard__head">
        <span className="v2-prcard__repo">{owner}/{repo}</span>
        <span className={`v2-prcard__state ${stateClass}`}>{stateLabel}</span>
      </div>
      <div className="v2-prcard__title">
        <span className="v2-prcard__num">#{pr.number}</span> {pr.title}
      </div>
      <div className="v2-prcard__meta">
        <span className="v2-prcard__metric">{pr.commits} commit{pr.commits === 1 ? '' : 's'}</span>
        <span className="v2-prcard__metric">{pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}</span>
        <span className="v2-prcard__metric v2-prcard__metric--add">+{pr.additions}</span>
        <span className="v2-prcard__metric v2-prcard__metric--del">−{pr.deletions}</span>
        {pr.contributors.length > 0 && (
          <span className="v2-prcard__contributors" aria-label={`${pr.contributors.length} contributor${pr.contributors.length === 1 ? '' : 's'}`}>
            {visibleContributors.map((c) => (
              <span
                key={c.login}
                className="v2-prcard__avatar"
                style={c.avatarUrl ? { backgroundImage: `url(${c.avatarUrl})` } : undefined}
                title={c.login}
              >
                {!c.avatarUrl && c.login.slice(0, 1).toUpperCase()}
              </span>
            ))}
            {overflowCount > 0 && (
              <span className="v2-prcard__avatar v2-prcard__avatar--overflow">+{overflowCount}</span>
            )}
          </span>
        )}
      </div>
    </a>
  );
};

// Match a github.com PR URL anywhere in a string. Capture (owner, repo, number).
// Anchored to a word boundary on either side so it doesn't match URLs nested
// inside other tokens.
export const GITHUB_PR_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?=\b|$)/g;

export interface ParsedGithubPr {
  owner: string;
  repo: string;
  number: number;
  fullUrl: string;
}

export const parseGithubPrUrls = (content: string): ParsedGithubPr[] => {
  const results: ParsedGithubPr[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  GITHUB_PR_URL_RE.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((match = GITHUB_PR_URL_RE.exec(content)) !== null) {
    const key = `${match[1]}/${match[2]}#${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
      fullUrl: match[0],
    });
  }
  return results;
};

export default V2GithubPrCard;
