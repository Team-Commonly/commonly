import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from '../utils/axiosConfig';

// v2-native invite-required gate. Pairs with V2Login / V2Register (reuses the
// .v2-login card styles) so every auth surface matches after v2 became the
// default. Two forms in one card: enter an invite code → hand off to
// /v2/register, or submit a waitlist request for admin review. Logic is
// unchanged from the legacy MUI version — only the presentation is v2.

const Brand: React.FC = () => (
  <div className="v2-login__brand">
    <span className="v2-rail__brand-icon">c</span>
    commonly
  </div>
);

const RegistrationInviteRequired: React.FC = () => {
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
    navigate(`/v2/register?invite=${encodeURIComponent(trimmed)}`);
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
      setWaitlistSuccess(res.data?.message || 'Waitlist request submitted.');
      setWaitlistName('');
      setWaitlistNote('');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setWaitlistError(e.response?.data?.error || 'Failed to submit waitlist request');
    } finally {
      setWaitlistLoading(false);
    }
  };

  return (
    <div className="v2-login">
      <div className="v2-login__card">
        <Brand />
        <h1 className="v2-login__title">Invitation required</h1>
        <p className="v2-login__subtitle">
          New account registration is invite-only right now. Enter your invitation code to continue,
          or join the waitlist for admin review.
        </p>

        <form onSubmit={onContinue}>
          <label className="v2-login__field">
            <span className="v2-login__label">Invitation code</span>
            <input
              className="v2-login__input"
              type="text"
              value={invitationCode}
              onChange={(e) => setInvitationCode(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="v2-login__submit">
            Continue to registration
          </button>
        </form>

        <div className="v2-login__divider">Need access? Join the waitlist</div>

        <form onSubmit={onWaitlistSubmit}>
          <label className="v2-login__field">
            <span className="v2-login__label">Email</span>
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
            <span className="v2-login__label">Name (optional)</span>
            <input
              className="v2-login__input"
              type="text"
              value={waitlistName}
              onChange={(e) => setWaitlistName(e.target.value)}
            />
          </label>
          <label className="v2-login__field">
            <span className="v2-login__label">Use case (optional)</span>
            <input
              className="v2-login__input"
              type="text"
              value={waitlistNote}
              onChange={(e) => setWaitlistNote(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="v2-login__submit v2-login__submit--ghost"
            disabled={waitlistLoading}
          >
            {waitlistLoading ? 'Submitting…' : 'Request waitlist access'}
          </button>
          {waitlistError && <div className="v2-login__error">{waitlistError}</div>}
          {waitlistSuccess && <div className="v2-login__success">{waitlistSuccess}</div>}
        </form>

        <div className="v2-login__hint">
          Already have an account?
          {' '}
          <Link to="/v2/login" className="v2-login__link">Sign in</Link>
        </div>
      </div>
    </div>
  );
};

export default RegistrationInviteRequired;
