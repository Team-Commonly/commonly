import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useV2Api } from '../hooks/useV2Api';
import V2Avatar from './V2Avatar';
import './V2PersonProfile.css';

/*
 * A person's page at /v2/profile/:id, drawn as d215 section s-profile
 * (docs/design/artboards/d215/index.html). Header (avatar, name, handle and
 * join date, counts, Follow), then "Pods in common" and "Recent posts" as
 * bordered lanes. A lane with no rows is omitted, never an empty box.
 */

interface SocialProfile {
  _id: string;
  username?: string;
  displayName?: string;
  profilePicture?: string;
  createdAt?: string;
  followersCount?: number;
  followingCount?: number;
  isFollowing?: boolean;
  isBot?: boolean;
  botMetadata?: { agentName?: string; instanceId?: string } | null;
}

interface FollowResponse { target?: { followersCount?: number } }

export interface ProfilePod { id: string; name: string; membersCount: number }
export interface ProfilePost { id: string; content: string; createdAt?: string }

interface PublicActivity {
  joinedPods?: Array<{ id?: string; _id?: string; name?: string; membersCount?: number }>;
  recentPublicPosts?: Array<{ id?: string; content?: string; createdAt?: string }>;
}

/**
 * The one place that reads the activity response. The backend is narrowing
 * `joinedPods` to the pods the viewer shares with this person; if that lands
 * under a new field name, change it here.
 */
export const mapPublicActivity = (data: PublicActivity | null | undefined): { pods: ProfilePod[]; posts: ProfilePost[] } => ({
  pods: (data?.joinedPods || [])
    .map((pod) => ({ id: String(pod.id || pod._id || ''), name: pod.name || '', membersCount: pod.membersCount || 0 }))
    .filter((pod) => pod.id),
  posts: (data?.recentPublicPosts || [])
    .map((post) => ({ id: String(post.id || ''), content: (post.content || '').replace(/\s+/g, ' ').trim(), createdAt: post.createdAt }))
    .filter((post) => post.id && post.content),
});

type LoadState = 'loading' | 'ready' | 'notFound' | 'error';

const JOINED_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', year: 'numeric' };
const POST_DATE_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

const formatDate = (value: string | undefined, language: string, options: Intl.DateTimeFormatOptions): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(language, options).format(date);
  } catch {
    return date.toDateString();
  }
};

// The frame sets each count in bold and its word in the secondary tone. The
// locale strings carry the number inside the sentence ("12 followers",
// "关注了8人"), so the formatted string is split at the number, not rebuilt.
const boldCount = (text: string, count: number): React.ReactNode => {
  const n = String(count);
  const at = text.indexOf(n);
  if (at < 0) return text;
  return <>{text.slice(0, at)}<b>{n}</b>{text.slice(at + n.length)}</>;
};

const V2PersonProfile: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { t, i18n } = useTranslation();
  const { currentUser } = useAuth();
  const [state, setState] = useState<LoadState>('loading');
  const [profile, setProfile] = useState<SocialProfile | null>(null);
  const [pods, setPods] = useState<ProfilePod[]>([]);
  const [posts, setPosts] = useState<ProfilePost[]>([]);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState(false);
  const api = useV2Api();
  // The profile on screen. A follow request that settles after the page has
  // moved to another person must not touch that person's header.
  const shownId = useRef(id);
  shownId.current = id;

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setProfile(null);
    setPods([]);
    setPosts([]);
    setFollowError(false);
    setFollowBusy(false);
    Promise.all([
      api.get<SocialProfile>(`/api/users/${encodeURIComponent(id)}`),
      // The activity lanes are secondary: a failure there still shows the person.
      api.get<PublicActivity>(`/api/users/${encodeURIComponent(id)}/public-activity`).catch(() => null),
    ]).then(([person, activity]) => {
      if (cancelled) return;
      const mapped = mapPublicActivity(activity);
      setProfile(person);
      setPods(mapped.pods);
      setPosts(mapped.posts);
      setState('ready');
    }).catch((error: unknown) => {
      if (cancelled) return;
      const status = (error as { response?: { status?: number } })?.response?.status;
      setState(status === 404 || status === 400 ? 'notFound' : 'error');
    });
    return () => { cancelled = true; };
  }, [api, id]);

  if (state === 'loading') {
    return <div className="v2-profile" aria-busy="true" />;
  }

  if (state !== 'ready' || !profile) {
    return (
      <div className="v2-profile">
        <p className="v2-profile__note">
          {state === 'notFound' ? t('profile.notFound') : t('profile.loadError')}{' '}
          <Link to="/v2">{t('profile.backHome')}</Link>
        </p>
      </div>
    );
  }

  const name = profile.displayName || profile.username || '';
  const isSelf = Boolean(currentUser?._id && String(currentUser._id) === String(profile._id));
  const joined = formatDate(profile.createdAt, i18n.language, JOINED_FORMAT);
  const following = Boolean(profile.isFollowing);
  const avatarKind = profile.isBot ? 'agent' : 'human';
  const agentHref = profile.botMetadata?.agentName
    ? `/v2/agent/${encodeURIComponent(profile.botMetadata.agentName)}/${encodeURIComponent(profile.botMetadata.instanceId || 'default')}`
    : '/v2/agents';

  const toggleFollow = async () => {
    if (followBusy) return;
    const targetId = profile._id;
    const before = { isFollowing: following, followersCount: profile.followersCount || 0 };
    const next = !following;
    // Applies only while this person is still the one on screen.
    const forTarget = (update: (p: SocialProfile) => SocialProfile) => setProfile((p) => (
      p && p._id === targetId ? update(p) : p
    ));
    setFollowBusy(true);
    setFollowError(false);
    forTarget((p) => ({ ...p, isFollowing: next, followersCount: Math.max(0, before.followersCount + (next ? 1 : -1)) }));
    try {
      const url = `/api/users/${encodeURIComponent(targetId)}/follow`;
      const res = await (next
        ? api.post<FollowResponse>(url, {})
        : api.del<FollowResponse>(url));
      const count = res?.target?.followersCount;
      if (typeof count === 'number') forTarget((p) => ({ ...p, followersCount: count }));
    } catch {
      forTarget((p) => ({ ...p, ...before }));
      if (shownId.current.toLowerCase() === targetId.toLowerCase()) setFollowError(true);
    } finally {
      if (shownId.current.toLowerCase() === targetId.toLowerCase()) setFollowBusy(false);
    }
  };

  let action: React.ReactNode = null;
  if (isSelf) {
    action = <Link className="v2-profile__edit" to="/v2/settings">{t('profile.editProfile')}</Link>;
  } else if (!profile.isBot) {
    action = (
      <button
        type="button"
        className={`v2-profile__follow${following ? ' v2-profile__follow--on' : ''}`}
        aria-pressed={following}
        disabled={followBusy}
        onClick={toggleFollow}
      >
        {following ? t('profile.following') : t('profile.follow')}
      </button>
    );
  }

  return (
    <div className="v2-profile">
      <header className="v2-profile__head">
        <span className="v2-profile__avatar">
          <V2Avatar
            name={name}
            src={profile.profilePicture || undefined}
            size="lg"
            kind={avatarKind}
            seed={profile._id}
          />
        </span>
        <div className="v2-profile__id">
          <h1 className="v2-profile__name">{name}</h1>
          <span className="v2-profile__meta">
            {profile.username ? `@${profile.username}` : null}
            {profile.username && joined ? ' · ' : null}
            {joined ? t('profile.joined', { date: joined }) : null}
          </span>
          {!profile.isBot && (
            <span className="v2-profile__counts" data-testid="profile-counts">
              {boldCount(t('profile.followers', { count: profile.followersCount || 0 }), profile.followersCount || 0)}
              {' · '}
              {boldCount(t('profile.followingCount', { count: profile.followingCount || 0 }), profile.followingCount || 0)}
            </span>
          )}
        </div>
        {action}
      </header>
      {followError && <p className="v2-profile__note" role="alert">{t('profile.followError')}</p>}

      {profile.isBot ? (
        <p className="v2-profile__note">
          {t('profile.agentNote')}{' '}
          <Link to={agentHref}>{t('profile.openAgent')}</Link>
        </p>
      ) : (
        <>
          {pods.length > 0 && (
            <section className="v2-profile__lane" aria-labelledby="v2-profile-pods">
              <h2 id="v2-profile-pods">{t(isSelf ? 'profile.yourPods' : 'profile.podsInCommon')}</h2>
              <ul className="v2-profile__list">
                {pods.map((pod) => (
                  <li key={pod.id}>
                    <Link className="v2-profile__row" to={`/v2/pods/${encodeURIComponent(pod.id)}`}>
                      <span className="v2-profile__row-title">{pod.name}</span>
                      <span className="v2-profile__row-meta">{t('profile.podMembers', { count: pod.membersCount })}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {posts.length > 0 && (
            <section className="v2-profile__lane" aria-labelledby="v2-profile-posts">
              <h2 id="v2-profile-posts">{t('profile.recentPosts')}</h2>
              <ul className="v2-profile__list">
                {posts.map((post) => (
                  <li key={post.id}>
                    <div className="v2-profile__row v2-profile__row--post">
                      <span className="v2-profile__row-text">{post.content}</span>
                      <span className="v2-profile__row-meta">
                        {formatDate(post.createdAt, i18n.language, POST_DATE_FORMAT)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
};

export default V2PersonProfile;
