import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import axios from '../../utils/axiosConfig';
import { ShellGlyph } from '../icons/glyphs';
import { DISCORD_INVITE_URL } from '../utils/feedbackLinks';
import { useOwnPostThisLoad } from '../utils/ownPost';
import { trackUsage } from '../utils/usageEvents';
import './V2DiscordCard.css';

interface DiscordCardUser {
  _id?: string;
  isBot?: boolean;
  verified?: boolean;
  createdAt?: string;
  onboarding?: { firstStartAt?: string; discordCardDismissedAt?: string };
}

// A dismissal reaches the account mark at once, but the signed-in user is
// only re-read on the next page load, so a remount in this load must remember it.
let closedThisLoad = false;
let shownSent = false;
/** Test seam: forget a dismissal and the shown ping from this page load. */
export const resetDiscordCardForTest = (): void => { closedThisLoad = false; shownSent = false; };

const startOfToday = (): number => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

// The card waits for a first real action: a message the person posted (now,
// or a Scout start before), or a visit on a later day than the one they
// signed up on. Accounts made before the card existed meet the second rule
// on their next visit, which is how they get the invite once.
const hasActed = (user: DiscordCardUser, postedThisLoad: boolean): boolean => {
  if (postedThisLoad || user.onboarding?.firstStartAt) return true;
  const created = user.createdAt ? new Date(user.createdAt).getTime() : NaN;
  return Number.isFinite(created) && created < startOfToday();
};

const recordStep = (step: 'discord-card-shown' | 'discord-card-dismissed'): void => {
  void axios.post('/api/stats/byo-step', { step }).catch(() => {});
};

const V2DiscordCard: React.FC = () => {
  const { currentUser } = useAuth();
  const { t } = useTranslation();
  const postedThisLoad = useOwnPostThisLoad();
  const [closed, setClosed] = useState(closedThisLoad);
  const user = (currentUser || null) as DiscordCardUser | null;

  // The email reminder takes the same strip; the card waits until it is gone.
  const visible = Boolean(user?._id)
    && !closed
    && !user?.isBot
    && user?.verified !== false
    && !user?.onboarding?.discordCardDismissedAt
    && hasActed(user as DiscordCardUser, postedThisLoad);

  useEffect(() => {
    if (!visible || shownSent) return;
    shownSent = true;
    recordStep('discord-card-shown');
  }, [visible]);

  if (!visible) return null;

  const close = () => {
    closedThisLoad = true;
    setClosed(true);
    recordStep('discord-card-dismissed');
  };

  return (
    <section className="v2-discord-card" aria-label="Discord">
      <ShellGlyph name="forum" size={17} className="v2-discord-card__glyph" />
      <p className="v2-discord-card__text">{t('discordCard.message')}</p>
      <a
        className="v2p-b v2p-b-p v2-discord-card__join"
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          trackUsage('discord-click', { props: { where: 'card' } });
          close();
        }}
      >
        {t('discordCard.join')}
      </a>
      <button
        type="button"
        className="v2-discord-card__dismiss"
        onClick={close}
        aria-label={t('discordCard.dismiss')}
      >
        <ShellGlyph name="close" size={17} />
      </button>
    </section>
  );
};

export default V2DiscordCard;
