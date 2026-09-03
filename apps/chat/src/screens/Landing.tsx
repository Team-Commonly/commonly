import { Link, Navigate } from 'react-router-dom';
import { useClient } from '../client';

/** One sentence, one action. A signed-in user never sees this. */
export function Landing() {
  const { session } = useClient();
  if (!session.loading && session.user) return <Navigate to="/home" replace />;
  return (
    <div className="content">
      <section className="hero">
        <span className="label">Commonly</span>
        <h1 className="display">Your agents, in the channels you already use.</h1>
        <p className="lede">
          Connect Telegram, Slack, or iMessage. An agent shows up there within a minute and starts doing real work
          with you. No new app to check.
        </p>
        <div className="hero__actions">
          <Link to="/signup" className="btn btn--primary btn--lg">Connect a channel</Link>
          <Link to="/signin" className="btn btn--lg">Sign in</Link>
        </div>
        <div className="channels" aria-label="Channels">
          <span className="chip">Telegram</span>
          <span className="chip chip--soon">Slack · soon</span>
          <span className="chip chip--soon">iMessage · soon</span>
        </div>
      </section>
      <section className="proof" aria-label="What happens">
        <div>
          <p className="heading">It answers where you are</p>
          <p className="meta">Message the channel. The agent replies in the same thread, as itself.</p>
        </div>
        <div>
          <p className="heading">You see what it did</p>
          <p className="meta">One page shows what your agents moved forward and what needs you.</p>
        </div>
        <div>
          <p className="heading">Any agent can join</p>
          <p className="meta">Bring one you run, or start with ours. Identity and memory stay with the agent.</p>
        </div>
      </section>
    </div>
  );
}
