import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';

// V2 marketplace detail page — `/v2/marketplace/:installableId`.
//
// Surfaces a single Installable manifest from /api/marketplace/manifests/:id
// (PR #215/#230 backend). Companion to the legacy AppsMarketplacePage mounted
// at /v2/marketplace; this is the missing detail surface the audit at
// docs/audits/ui-smoke-2026-05-23/marketplace-v2-gaps.md called out as the
// next-biggest gap after the browse-rewire (PR #436).
//
// Scope (minimum viable):
//   - Identity: name + displayName + version + publisher + verified badge
//   - Pitch: description + readme (markdown)
//   - Shape: kind + scope + components[] + requires (scopes)
//   - Stats: total installs + rating
//   - Action: "Install" button → routes to /v2/agents/browse, which already
//     owns the install dialog. No duplicated install UX here.
//
// Intentionally not in this PR:
//   - Publish / fork / deprecate flows
//   - Version timeline (versions[] is in the doc but rendering it well
//     needs a timeline component we don't have)
//   - Forks list (separate /forks endpoint; can come next)

interface Installable {
  _id?: string;
  installableId?: string;
  name?: string;
  description?: string;
  readme?: string;
  kind?: string;
  source?: string;
  scope?: string;
  status?: string;
  marketplace?: {
    displayName?: string;
    category?: string;
    rating?: number;
    ratingCount?: number;
    verified?: boolean;
    publisher?: {
      name?: string;
      userId?: string;
    };
    logoUrl?: string;
  };
  stats?: {
    totalInstalls?: number;
    forkCount?: number;
  };
  requires?: string[];
  components?: Array<{
    type?: string;
    name?: string;
  }>;
  latestVersion?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

const formatNumber = (n: number | undefined): string => {
  if (!Number.isFinite(n) || !n) return '0';
  const v = Number(n);
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
};

const formatRating = (r: number | undefined, count: number | undefined): string => {
  if (!r) return 'unrated';
  const fixed = r.toFixed(1);
  return count ? `${fixed} (${count})` : fixed;
};

const V2MarketplaceDetailPage: React.FC = () => {
  const { installableId } = useParams<{ installableId: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<Installable | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!installableId) {
      setError('No installable specified');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = { 'x-auth-token': token || '' };
    axios
      .get<Installable>(`/api/marketplace/manifests/${encodeURIComponent(installableId)}`, { headers })
      .then((res) => {
        setDoc(res.data);
      })
      .catch((err) => {
        // 404 surfaces the most common case (unknown installable / typo'd URL).
        // Other failures show a generic error; the network details are in the
        // console for operators.
        if (err?.response?.status === 404) {
          setError('Manifest not found');
        } else {
          setError('Failed to load marketplace entry');
          // eslint-disable-next-line no-console
          console.error('[v2-marketplace-detail] fetch error:', err?.message || err);
        }
      })
      .finally(() => setLoading(false));
  }, [installableId]);

  if (loading) {
    return (
      <div className="v2-marketplace-detail v2-marketplace-detail--loading">
        Loading…
      </div>
    );
  }
  if (error || !doc) {
    return (
      <div className="v2-marketplace-detail v2-marketplace-detail--error">
        <div className="v2-empty__title">{error || 'Not found'}</div>
        <div className="v2-empty__text">
          <Link to="/v2/marketplace">← Back to marketplace</Link>
        </div>
      </div>
    );
  }

  const display = doc.marketplace?.displayName || doc.name || doc.installableId || 'Untitled';
  const category = doc.marketplace?.category || 'other';
  const kind = doc.kind || 'app';
  const verified = Boolean(doc.marketplace?.verified);
  const publisher = doc.marketplace?.publisher?.name || 'unknown';
  const totalInstalls = formatNumber(doc.stats?.totalInstalls);
  const rating = formatRating(doc.marketplace?.rating, doc.marketplace?.ratingCount);
  const components = Array.isArray(doc.components) ? doc.components : [];
  const requires = Array.isArray(doc.requires) ? doc.requires : [];

  // "Install" → bounce to /v2/agents/browse, which already owns the install
  // dialog. Future polish: deep-link to pre-open that dialog for this
  // installable. For now, the operator clicks Install on the matching row.
  const handleInstall = () => {
    navigate(`/v2/agents/browse?installable=${encodeURIComponent(doc.installableId || doc._id || '')}`);
  };

  return (
    <div className="v2-marketplace-detail">
      <div className="v2-marketplace-detail__header">
        <Link to="/v2/marketplace" className="v2-marketplace-detail__back">
          ← Back to marketplace
        </Link>

        <div className="v2-marketplace-detail__identity">
          {doc.marketplace?.logoUrl ? (
            <img
              className="v2-marketplace-detail__logo"
              src={doc.marketplace.logoUrl}
              alt=""
              aria-hidden="true"
            />
          ) : (
            <div className="v2-marketplace-detail__logo v2-marketplace-detail__logo--placeholder">
              {display.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="v2-marketplace-detail__title-block">
            <h1 className="v2-marketplace-detail__title">
              {display}
              {verified ? (
                <span className="v2-marketplace-detail__badge" title="Verified by Commonly">
                  ✓ Verified
                </span>
              ) : null}
            </h1>
            <div className="v2-marketplace-detail__meta">
              <span className="v2-marketplace-detail__kind">{kind}</span>
              <span className="v2-marketplace-detail__sep">·</span>
              <span className="v2-marketplace-detail__category">{category}</span>
              <span className="v2-marketplace-detail__sep">·</span>
              <span className="v2-marketplace-detail__publisher">by {publisher}</span>
            </div>
            <div className="v2-marketplace-detail__stats">
              <span>{totalInstalls} installs</span>
              <span className="v2-marketplace-detail__sep">·</span>
              <span>★ {rating}</span>
              {doc.latestVersion ? (
                <>
                  <span className="v2-marketplace-detail__sep">·</span>
                  <span>v{doc.latestVersion}</span>
                </>
              ) : null}
            </div>
          </div>
          <button type="button" className="v2-marketplace-detail__install" onClick={handleInstall}>
            Install
          </button>
        </div>
      </div>

      <div className="v2-marketplace-detail__body">
        {doc.description ? (
          <p className="v2-marketplace-detail__description">{doc.description}</p>
        ) : null}

        {components.length > 0 ? (
          <section className="v2-marketplace-detail__section">
            <h2>Components</h2>
            <ul className="v2-marketplace-detail__components">
              {components.map((c, i) => (
                <li key={`${c.type}-${c.name}-${i}`}>
                  <span className="v2-marketplace-detail__component-type">{c.type || 'component'}</span>
                  <span className="v2-marketplace-detail__component-name">{c.name || ''}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {requires.length > 0 ? (
          <section className="v2-marketplace-detail__section">
            <h2>Required scopes</h2>
            <ul className="v2-marketplace-detail__requires">
              {requires.map((s) => (
                <li key={s} className="v2-marketplace-detail__scope">{s}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {doc.readme ? (
          <section className="v2-marketplace-detail__section">
            <h2>About</h2>
            <div className="v2-marketplace-detail__readme">
              <ReactMarkdown>{doc.readme}</ReactMarkdown>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
};

export default V2MarketplaceDetailPage;
