/**
 * Global integrations (admin, /v2/admin/integrations/global): the instance's
 * X and Instagram feed accounts, the backend LLM policy and the social
 * publishing policy. The v2 port of the retired MUI page, with the same calls.
 */
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import './V2GlobalIntegrations.css';

// F98 (decided 11-04): platform features (llmService) are Claude-only, and
// they have no model list here. The server always returns a full policy (what
// was saved, or its own defaults, which still name Gemini), so a current value
// that is no longer offered still shows, disabled and marked current.
const LLM_SERVICE_PROVIDERS = [
  { value: 'auto', label: 'Auto (LiteLLM then Gemini)' },
  { value: 'litellm', label: 'LiteLLM' },
  { value: 'openrouter', label: 'OpenRouter' },
];

// Saved tokens never come back from the API; the field is write-only once one is on file.
const SAVED_TOKEN_PLACEHOLDER = 'Saved — leave blank to keep';
const SAVED_TOKEN_HELPER = 'A token is on file. Paste a new one to replace it.';

const RETURN_PATH = '/admin/integrations/global';

interface XConfig {
  enabled: boolean; accessToken: string; tokenOnFile: boolean; username: string; userId: string;
  followUsernames: string; followUserIds: string; followFromAuthenticatedUser: boolean;
  followingWhitelistUserIds: string; followingMaxUsers: number; status: string;
}
interface InstagramConfig {
  enabled: boolean; accessToken: string; tokenOnFile: boolean; username: string; igUserId: string; status: string;
}
interface ModelPolicy {
  llmService: { provider: string; model: string; openrouter: { baseUrl: string; model: string } };
}
interface SocialPolicy { socialMode: string; publishEnabled: boolean; strictAttribution: boolean }

const EMPTY_X: XConfig = {
  enabled: false, accessToken: '', tokenOnFile: false, username: '', userId: '', followUsernames: '',
  followUserIds: '', followFromAuthenticatedUser: false, followingWhitelistUserIds: '', followingMaxUsers: 5,
  status: 'disconnected',
};
const EMPTY_INSTAGRAM: InstagramConfig = {
  enabled: false, accessToken: '', tokenOnFile: false, username: '', igUserId: '', status: 'disconnected',
};

const joinList = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : '');

const errorText = (err: unknown, fallback: string): string => {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error || fallback;
};

const authHeaders = () => ({ headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });

const Field: React.FC<{ label: string; hint?: string; children: (id: string) => React.ReactNode }> = ({ label, hint, children }) => {
  const id = `v2-global-int-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${React.useId().replace(/:/g, '')}`;
  return (
    <div className="v2-global-int__field">
      <label className="v2-global-int__label" htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="v2-global-int__hint">{hint}</span>}
    </div>
  );
};

const Check: React.FC<{ label: string; checked: boolean; onChange: (next: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="v2-global-int__check">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
);

const Status: React.FC<{ status: string }> = ({ status }) => (
  <span className={`v2p-chip${status === 'connected' ? ' v2-global-int__status--on' : ''}`}>
    {status === 'connected' ? 'Connected' : 'Disconnected'}
  </span>
);

const V2GlobalIntegrations: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connectingX, setConnectingX] = useState(false);
  const [loadingXFollowing, setLoadingXFollowing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [socialPolicy, setSocialPolicy] = useState<SocialPolicy>({
    socialMode: 'repost', publishEnabled: false, strictAttribution: true,
  });
  const [modelPolicy, setModelPolicy] = useState<ModelPolicy>({
    llmService: { provider: 'auto', model: 'claude-haiku-5-5', openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '' } },
  });
  const [xConfig, setXConfig] = useState<XConfig>(EMPTY_X);
  const [instagramConfig, setInstagramConfig] = useState<InstagramConfig>(EMPTY_INSTAGRAM);

  const fetchIntegrations = useCallback(async () => {
    try {
      setError('');
      const { data } = await axios.get('/api/admin/integrations/global', authHeaders());
      const { x, instagram, socialPolicy: nextPolicy, modelPolicy: nextModelPolicy } = data || {};
      if (x) {
        setXConfig({
          enabled: x.status === 'connected',
          // The API never returns the saved token; a stored row always carries one.
          accessToken: '',
          tokenOnFile: true,
          username: x.config?.username || '',
          userId: x.config?.userId || '',
          followUsernames: joinList(x.config?.followUsernames),
          followUserIds: joinList(x.config?.followUserIds),
          followFromAuthenticatedUser: x.config?.followFromAuthenticatedUser === true,
          followingWhitelistUserIds: joinList(x.config?.followingWhitelistUserIds),
          followingMaxUsers: Number.isFinite(Number(x.config?.followingMaxUsers)) ? Number(x.config.followingMaxUsers) : 5,
          status: x.status,
        });
      }
      if (instagram) {
        setInstagramConfig({
          enabled: instagram.status === 'connected',
          accessToken: '',
          tokenOnFile: true,
          username: instagram.config?.username || '',
          igUserId: instagram.config?.igUserId || '',
          status: instagram.status,
        });
      }
      if (nextPolicy) {
        setSocialPolicy({
          socialMode: nextPolicy.socialMode || 'repost',
          publishEnabled: Boolean(nextPolicy.publishEnabled),
          strictAttribution: nextPolicy.strictAttribution !== false,
        });
      }
      if (nextModelPolicy) {
        const llm = nextModelPolicy.llmService || {};
        setModelPolicy({
          llmService: {
            provider: llm.provider || 'auto',
            model: llm.model || llm.defaultModel || 'claude-haiku-5-5',
            openrouter: {
              baseUrl: llm.openrouter?.baseUrl || 'https://openrouter.ai/api/v1',
              model: llm.openrouter?.model || '',
            },
          },
        });
      }
    } catch (err) {
      setError(errorText(err, 'Failed to load integrations'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchIntegrations(); }, [fetchIntegrations]);

  // The X OAuth callback returns here with ?xOAuth=success|error&detail=…
  useEffect(() => {
    const params = new URLSearchParams(location.search || '');
    const oauthStatus = params.get('xOAuth');
    const detail = params.get('detail');
    if (!oauthStatus) return;
    if (oauthStatus === 'success') {
      setSuccess(detail ? `X OAuth connected (${detail})` : 'X OAuth connected successfully');
      setError('');
      fetchIntegrations();
    } else {
      setError(detail || 'X OAuth connection failed');
      setSuccess('');
    }
    navigate(RETURN_PATH, { replace: true });
  }, [location.search, navigate, fetchIntegrations]);

  // One save shape for every form: clear the notices, post, announce, re-read.
  const save = async (path: string, body: unknown, done: string, failed: string) => {
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      await axios.post(path, body, authHeaders());
      setSuccess(done);
      await fetchIntegrations();
    } catch (err) {
      setError(errorText(err, failed));
    } finally {
      setSaving(false);
    }
  };

  // No openclaw section: the OpenClaw runtime is retired (ADR-021 Part B), and
  // a save that names none keeps the stored one as it was. llmService reads
  // the policy on every call, so a save applies without a reprovision.
  const saveModelPolicy = () => save('/api/admin/integrations/global/model-policy', {
    llmService: {
      provider: modelPolicy.llmService.provider || 'auto',
      model: modelPolicy.llmService.model || '',
      openrouter: {
        baseUrl: modelPolicy.llmService.openrouter.baseUrl || '',
        model: modelPolicy.llmService.openrouter.model || '',
      },
    },
  }, 'Global model policy saved.', 'Failed to save global model policy');

  const saveSocialPolicy = () => save('/api/admin/integrations/global/policy', socialPolicy,
    'Global social publishing policy saved.', 'Failed to save social policy');

  const saveX = () => save('/api/admin/integrations/global/x', {
    enabled: xConfig.enabled,
    // Omitted when blank: the server keeps the token on file.
    accessToken: xConfig.accessToken || undefined,
    username: xConfig.username,
    userId: xConfig.userId,
    followUsernames: xConfig.followUsernames,
    followUserIds: xConfig.followUserIds,
    followFromAuthenticatedUser: xConfig.followFromAuthenticatedUser,
    followingWhitelistUserIds: xConfig.followingWhitelistUserIds,
    followingMaxUsers: xConfig.followingMaxUsers,
  }, 'X integration saved successfully!', 'Failed to save X integration');

  const saveInstagram = () => save('/api/admin/integrations/global/instagram', {
    enabled: instagramConfig.enabled,
    accessToken: instagramConfig.accessToken || undefined,
    username: instagramConfig.username,
    igUserId: instagramConfig.igUserId,
  }, 'Instagram integration saved successfully!', 'Failed to save Instagram integration');

  const testConnection = async (type: 'x' | 'instagram') => {
    try {
      setError('');
      await axios.post(`/api/admin/integrations/global/${type}/test`, {}, authHeaders());
      setSuccess(`${type === 'x' ? 'X' : 'Instagram'} connection test successful!`);
    } catch (err) {
      setError(errorText(err, `Failed to test ${type} connection`));
    }
  };

  const connectXOAuth = async () => {
    try {
      setConnectingX(true);
      setError('');
      setSuccess('');
      const { data } = await axios.post('/api/admin/integrations/global/x/oauth/start', { redirectPath: RETURN_PATH }, authHeaders());
      if (!data?.authorizeUrl) throw new Error('Missing X OAuth URL');
      window.location.assign(data.authorizeUrl);
    } catch (err) {
      setError(errorText(err, (err as Error)?.message || 'Failed to start X OAuth'));
      setConnectingX(false);
    }
  };

  const loadXFollowingAsWhitelist = async () => {
    try {
      setLoadingXFollowing(true);
      setError('');
      const max = Number(xConfig.followingMaxUsers);
      const limit = Number.isFinite(max) ? Math.min(Math.max(Math.trunc(max), 1), 100) : 5;
      const { data } = await axios.get(`/api/admin/integrations/global/x/following?limit=${limit}`, authHeaders());
      const users = Array.isArray(data?.users) ? data.users : [];
      const ids = users.map((user: { id?: unknown }) => String(user?.id || '').trim()).filter(Boolean);
      setXConfig((prev) => ({ ...prev, followFromAuthenticatedUser: true, followingWhitelistUserIds: ids.join(', ') }));
      setSuccess(ids.length ? `Loaded ${ids.length} following account IDs into whitelist` : 'No following accounts returned from X');
    } catch (err) {
      setError(errorText(err, 'Failed to load following list from X'));
    } finally {
      setLoadingXFollowing(false);
    }
  };

  if (loading) return <p className="v2-global-int__sub" role="status">Loading integrations…</p>;

  const llm = modelPolicy.llmService;
  const setLlm = (patch: Partial<ModelPolicy['llmService']>) => setModelPolicy({ llmService: { ...llm, ...patch } });
  const providerOffered = LLM_SERVICE_PROVIDERS.some((p) => p.value === llm.provider);
  const xReady = Boolean(xConfig.username && xConfig.userId && (xConfig.accessToken || xConfig.tokenOnFile));
  const instagramReady = Boolean(instagramConfig.username && instagramConfig.igUserId && (instagramConfig.accessToken || instagramConfig.tokenOnFile));
  const connectedCount = (xConfig.status === 'connected' ? 1 : 0) + (instagramConfig.status === 'connected' ? 1 : 0);

  return (
    <div className="v2-global-int">
      {error && (
        <div className="v2-global-int__notice v2-global-int__notice--error" role="alert">
          <span>{error}</span>
          <button type="button" className="v2-global-int__dismiss" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      {success && (
        <div className="v2-global-int__notice v2-global-int__notice--success" role="status">
          <span>{success}</span>
          <button type="button" className="v2-global-int__dismiss" onClick={() => setSuccess('')}>Dismiss</button>
        </div>
      )}

      <p className="v2-global-int__eyebrow">Social</p>
      <div className="v2-global-int__pair">
        <section className="v2-global-int__card" aria-labelledby="v2-global-int-x">
          <div className="v2-global-int__head">
            <div className="v2-global-int__name"><h2 className="v2-global-int__title" id="v2-global-int-x">X (Twitter)</h2><Status status={xConfig.status} /></div>
            <Check label="Enabled" checked={xConfig.enabled} onChange={(enabled) => setXConfig({ ...xConfig, enabled })} />
          </div>
          <details className="v2-global-int__details">
            <summary>Configure</summary>
            <div className="v2-global-int__fields">
              <button type="button" className="v2p-b v2p-b-s" onClick={connectXOAuth} disabled={saving || connectingX}>
                {connectingX ? 'Redirecting to X OAuth...' : 'Connect with X OAuth'}
              </button>
              <Field label="Username" hint="X account username (without @)">
                {(id) => <input id={id} className="v2-global-int__input" placeholder="CommonlyHQ" value={xConfig.username} onChange={(e) => setXConfig({ ...xConfig, username: e.target.value })} />}
              </Field>
              <Field label="User ID" hint="Numeric user ID from X API">
                {(id) => <input id={id} className="v2-global-int__input" placeholder="123456789" value={xConfig.userId} onChange={(e) => setXConfig({ ...xConfig, userId: e.target.value })} />}
              </Field>
              <Field label="Access Token" hint={xConfig.tokenOnFile ? SAVED_TOKEN_HELPER : 'OAuth 2.0 Bearer token'}>
                {(id) => (
                  <input
                    id={id}
                    className="v2-global-int__input"
                    type="password"
                    autoComplete="off"
                    placeholder={xConfig.tokenOnFile ? SAVED_TOKEN_PLACEHOLDER : 'Bearer token...'}
                    value={xConfig.accessToken}
                    onChange={(e) => setXConfig({ ...xConfig, accessToken: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Follow Usernames (optional)" hint="Comma-separated usernames to watch in addition to the main account">
                {(id) => <input id={id} className="v2-global-int__input" placeholder="sama, paulgraham, levelsio" value={xConfig.followUsernames} onChange={(e) => setXConfig({ ...xConfig, followUsernames: e.target.value })} />}
              </Field>
              <Field label="Follow User IDs (optional)" hint="Optional comma-separated user IDs for direct ingestion">
                {(id) => <input id={id} className="v2-global-int__input" placeholder="123456,789012" value={xConfig.followUserIds} onChange={(e) => setXConfig({ ...xConfig, followUserIds: e.target.value })} />}
              </Field>
              <Check
                label="Watch authenticated user's following list"
                checked={xConfig.followFromAuthenticatedUser}
                onChange={(followFromAuthenticatedUser) => setXConfig({ ...xConfig, followFromAuthenticatedUser })}
              />
              <Field label="Following Max Users" hint="Cost control: only inspect this many followed accounts per sync (1-100, recommended 5-20)">
                {(id) => <input id={id} className="v2-global-int__input" type="number" value={xConfig.followingMaxUsers} onChange={(e) => setXConfig({ ...xConfig, followingMaxUsers: Number(e.target.value) })} />}
              </Field>
              <Field label="Following Whitelist User IDs (optional)" hint="If set, only these IDs from your following list are ingested">
                {(id) => <input id={id} className="v2-global-int__input" placeholder="44196397, 783214, ..." value={xConfig.followingWhitelistUserIds} onChange={(e) => setXConfig({ ...xConfig, followingWhitelistUserIds: e.target.value })} />}
              </Field>
              <button
                type="button"
                className="v2p-b v2p-b-s"
                onClick={loadXFollowingAsWhitelist}
                disabled={saving || loadingXFollowing || xConfig.status !== 'connected'}
              >
                {loadingXFollowing ? 'Loading following list...' : 'Load OAuth Following IDs Into Whitelist'}
              </button>
              <div className="v2-global-int__row">
                <button type="button" className="v2p-b v2p-b-p" onClick={saveX} disabled={saving || !xReady}>Save X Configuration</button>
                <button type="button" className="v2p-b v2p-b-g" onClick={() => testConnection('x')} disabled={xConfig.status !== 'connected'}>Test connection</button>
              </div>
            </div>
          </details>
          <p className="v2-global-int__notice v2-global-int__notice--info">
            Prefer OAuth connect above for user-context tokens. Manual token entry is fallback only.
          </p>
        </section>

        <section className="v2-global-int__card" aria-labelledby="v2-global-int-instagram">
          <div className="v2-global-int__head">
            <div className="v2-global-int__name"><h2 className="v2-global-int__title" id="v2-global-int-instagram">Instagram</h2><Status status={instagramConfig.status} /></div>
            <Check label="Enabled" checked={instagramConfig.enabled} onChange={(enabled) => setInstagramConfig({ ...instagramConfig, enabled })} />
          </div>
          <details className="v2-global-int__details">
            <summary>Configure</summary>
            <div className="v2-global-int__fields">
              <Field label="Username" hint="Instagram account username (without @)">
                {(id) => <input id={id} className="v2-global-int__input" placeholder="commonly.app" value={instagramConfig.username} onChange={(e) => setInstagramConfig({ ...instagramConfig, username: e.target.value })} />}
              </Field>
              <Field label="Instagram User ID" hint="Instagram Business Account ID">
                {(id) => <input id={id} className="v2-global-int__input" placeholder="123456789" value={instagramConfig.igUserId} onChange={(e) => setInstagramConfig({ ...instagramConfig, igUserId: e.target.value })} />}
              </Field>
              <Field label="Access Token" hint={instagramConfig.tokenOnFile ? SAVED_TOKEN_HELPER : 'Long-lived access token from Facebook Graph API'}>
                {(id) => (
                  <input
                    id={id}
                    className="v2-global-int__input"
                    type="password"
                    autoComplete="off"
                    placeholder={instagramConfig.tokenOnFile ? SAVED_TOKEN_PLACEHOLDER : 'Long-lived access token...'}
                    value={instagramConfig.accessToken}
                    onChange={(e) => setInstagramConfig({ ...instagramConfig, accessToken: e.target.value })}
                  />
                )}
              </Field>
              <div className="v2-global-int__row">
                <button type="button" className="v2p-b v2p-b-p" onClick={saveInstagram} disabled={saving || !instagramReady}>Save Instagram Configuration</button>
                <button type="button" className="v2p-b v2p-b-g" onClick={() => testConnection('instagram')} disabled={instagramConfig.status !== 'connected'}>Test connection</button>
              </div>
            </div>
          </details>
          <p className="v2-global-int__notice v2-global-int__notice--info">
            Get your Instagram credentials from{' '}
            <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener noreferrer">Meta for Developers</a>
          </p>
        </section>
      </div>

      <section className="v2-global-int__card" aria-labelledby="v2-global-int-model">
        <div>
          <h2 className="v2-global-int__name" id="v2-global-int-model">Global Model Policy</h2>
          <p className="v2-global-int__sub">Set global defaults for backend LLM routing.</p>
        </div>
        <div className="v2-global-int__grid">
          <Field label="Backend LLM Provider">
            {(id) => (
              <select id={id} className="v2-global-int__input" value={llm.provider} onChange={(e) => setLlm({ provider: e.target.value })}>
                {!providerOffered && <option value={llm.provider} disabled>{`${llm.provider} (current)`}</option>}
                {LLM_SERVICE_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Backend Model" hint="Used by llmService when callers do not pass a model.">
            {(id) => <input id={id} className="v2-global-int__input" value={llm.model} onChange={(e) => setLlm({ model: e.target.value })} />}
          </Field>
          {llm.provider === 'openrouter' && (
            <>
              <Field label="OpenRouter Base URL">
                {(id) => <input id={id} className="v2-global-int__input" value={llm.openrouter.baseUrl} onChange={(e) => setLlm({ openrouter: { ...llm.openrouter, baseUrl: e.target.value } })} />}
              </Field>
              <Field label="OpenRouter Model" hint="The model ID OpenRouter routes to.">
                {(id) => <input id={id} className="v2-global-int__input" value={llm.openrouter.model} onChange={(e) => setLlm({ openrouter: { ...llm.openrouter, model: e.target.value } })} />}
              </Field>
            </>
          )}
        </div>
        <div className="v2-global-int__row">
          <button type="button" className="v2p-b v2p-b-p" onClick={saveModelPolicy} disabled={saving}>Save Model Policy</button>
        </div>
        <p className="v2-global-int__notice v2-global-int__notice--info">
          OpenRouter API key is sourced from Kubernetes secrets/env only (not editable in UI). Gemini continues using GEMINI_API_KEY.
        </p>
      </section>

      <section className="v2-global-int__card" aria-labelledby="v2-global-int-social">
        <div>
          <h2 className="v2-global-int__name" id="v2-global-int-social">Global Social Publishing Policy</h2>
          <p className="v2-global-int__sub">These settings apply to all agent external publishes from runtime endpoints.</p>
        </div>
        <div className="v2-global-int__grid">
          <Field label="Social Mode">
            {(id) => (
              <select id={id} className="v2-global-int__input" value={socialPolicy.socialMode} onChange={(e) => setSocialPolicy({ ...socialPolicy, socialMode: e.target.value })}>
                <option value="repost">Repost</option>
                <option value="rewrite">Rewrite</option>
              </select>
            )}
          </Field>
        </div>
        <div className="v2-global-int__row">
          <Check label="Enable external publish" checked={socialPolicy.publishEnabled} onChange={(publishEnabled) => setSocialPolicy({ ...socialPolicy, publishEnabled })} />
          <Check label="Strict attribution (require source URL)" checked={socialPolicy.strictAttribution} onChange={(strictAttribution) => setSocialPolicy({ ...socialPolicy, strictAttribution })} />
        </div>
        <div className="v2-global-int__row">
          <button type="button" className="v2p-b v2p-b-p" onClick={saveSocialPolicy} disabled={saving}>Save Policy</button>
        </div>
        <p className="v2-global-int__notice v2-global-int__notice--info">
          Repost mode is link-first and avoids AI rewrite text for external channels.
        </p>
      </section>

      <section className="v2-global-int__card" aria-labelledby="v2-global-int-status">
        <h2 className="v2-global-int__name" id="v2-global-int-status">Integration Status</h2>
        <dl className="v2-global-int__stats">
          <div><dt>Active Integrations</dt><dd>{`${connectedCount} / 2`}</dd></div>
          <div><dt>Polling Frequency</dt><dd>10 min</dd></div>
          <div><dt>Content Category</dt><dd>Social</dd></div>
        </dl>
        <p className="v2-global-int__notice v2-global-int__notice--info">
          Posts from these integrations are automatically available to all curator agents via <code>GET /api/posts?category=Social</code>
        </p>
      </section>
    </div>
  );
};

export default V2GlobalIntegrations;
