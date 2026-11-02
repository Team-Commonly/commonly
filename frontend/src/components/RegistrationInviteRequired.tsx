import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from '../utils/axiosConfig';
import { useTranslation } from 'react-i18next';
import V2AuthBrand from '../v2/components/V2AuthBrand';
import V2AuthNotice from '../v2/components/V2AuthNotice';
import { registerPathWithInvite } from '../v2/utils/pendingInvite';

// v2-native invite-required gate. Pairs with V2Login / V2Register (reuses the
// .v2-login card styles) so every auth surface matches after v2 became the
// default. Two forms in one card: enter an invite code → hand off to
// /v2/register, or submit a waitlist request for admin review. The layout is
// the d215 invitation-required frame: the code first, the waitlist below the
// "or" rule, its result in one row above its key.

const RegistrationInviteRequired: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [invitationCode, setInvitationCode] = useState('');
  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [waitlistName, setWaitlistName] = useState('');
  const [waitlistNote, setWaitlistNote] = useState('');
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistError, setWaitlistError] = useState('');
  const [waitlistSuccess, setWaitlistSuccess] = useState('');

  const onContinue = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const trimmed = invitationCode.trim();
    if (!trimmed) return;
    navigate(registerPathWithInvite(trimmed));
  };

  const onWaitlistSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setWaitlistError('');
    setWaitlistSuccess('');
    try {
      setWaitlistLoading(true);
      const res = await axios.post<{ message?: string }>('/api/auth/waitlist', {
        email: waitlistEmail,
        name: waitlistName,
        useCase: waitlistNote,
      });
      setWaitlistSuccess(res.data?.message || t('auth.inviteRequired.waitlistSubmitted'));
      setWaitlistName('');
      setWaitlistNote('');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setWaitlistError(e.response?.data?.error || t('auth.inviteRequired.errors.waitlistFailed'));
    } finally {
      setWaitlistLoading(false);
    }
  };

  return (
    <div className="v2-login">
      <div className="v2-login__card v2-login__card--stack">
        <V2AuthBrand />
        <h1 className="v2-login__title">{t('auth.inviteRequired.title')}</h1>
        <p className="v2-login__subtitle">
          {t('auth.inviteRequired.subtitle')}
        </p>

        <form onSubmit={onContinue}>
          <label className="v2-login__field">
            <span className="v2-login__label">{t('auth.inviteRequired.code')}</span>
            <input
              className="v2-login__input"
              type="text"
              value={invitationCode}
              onChange={(e) => setInvitationCode(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="v2-login__submit">
            {t('auth.inviteRequired.continue')}
          </button>
        </form>

        <div className="v2-login__or">{t('auth.inviteRequired.joinWaitlist')}</div>

        <form onSubmit={onWaitlistSubmit}>
          <label className="v2-login__field">
            <span className="v2-login__label">{t('auth.fields.email')}</span>
            <input
              className="v2-login__input"
              type="email"
              autoComplete="email"
              value={waitlistEmail}
              onChange={(e) => setWaitlistEmail(e.target.value)}
              required
            />
          </label>
          <label className="v2-login__field">
            <span className="v2-login__label">
              {t('auth.inviteRequired.name')}
              <em>{t('auth.fields.optional')}</em>
            </span>
            <input
              className="v2-login__input"
              type="text"
              value={waitlistName}
              onChange={(e) => setWaitlistName(e.target.value)}
            />
          </label>
          <label className="v2-login__field">
            <span className="v2-login__label">
              {t('auth.inviteRequired.useCase')}
              <em>{t('auth.fields.optional')}</em>
            </span>
            <input
              className="v2-login__input"
              type="text"
              value={waitlistNote}
              onChange={(e) => setWaitlistNote(e.target.value)}
            />
          </label>
          {waitlistError && <V2AuthNotice>{waitlistError}</V2AuthNotice>}
          {waitlistSuccess && <V2AuthNotice kind="status">{waitlistSuccess}</V2AuthNotice>}
          <button
            type="submit"
            className="v2-login__submit v2-login__submit--ghost"
            disabled={waitlistLoading}
          >
            {waitlistLoading ? t('auth.inviteRequired.submitting') : t('auth.inviteRequired.requestAccess')}
          </button>
        </form>

        <p className="v2-login__alt">
          {t('auth.register.alreadyHaveAccount')}
          {' '}
          <Link to="/v2/login" className="v2-login__link">{t('auth.login.submit')}</Link>
        </p>
      </div>
    </div>
  );
};

export default RegistrationInviteRequired;
