// @ts-nocheck
// Quote suppression inside a thread rail — TASK-049 item 2, ruling
// constraint 5 (Sam 57491): hide the quote IFF it points at the root of the
// rail we are already inside.
//
// Four cells, because the predicate is a conjunction and neither half is
// sufficient. The two that matter are the ones where a careless version
// (`inThread ? hide : show`) gets it wrong: quoting a PERSON inside a rail,
// and quoting the root while rendered FLAT.
//
// Asymmetric on purpose: a redundant quote is noise, a missing one loses the
// only pointer to what a message answers.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2MessageRow from '../components/V2MessageRow';

jest.mock('../components/V2Avatar', () => {
  const MockAvatar = () => <span data-testid="avatar" />;
  MockAvatar.displayName = 'MockAvatar';
  return MockAvatar;
});
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { _id: 'u1', username: 'me' }, token: 't' }),
}));
jest.mock('../hooks/useV2Api', () => ({ useV2Api: () => ({ get: jest.fn(), post: jest.fn() }) }));

const msg = (replyToId, replyAuthor) => ({
  id: 'm9',
  pod_id: 'p1',
  user_id: 'u2',
  content: 'the reply body',
  message_type: 'text',
  created_at: '2026-08-23T00:00:00Z',
  user: { username: 'other', isBot: false },
  replyTo: { id: replyToId, content: 'the quoted text', username: replyAuthor },
});

const show = (props) => render(
  <MemoryRouter><V2MessageRow message={msg('root-1', 'rootauthor')} {...props} /></MemoryRouter>,
);

describe('the quote is hidden only when the rail already supplies its context', () => {
  test('inside the rail, quoting THAT root — hidden', () => {
    show({ insideThreadRoot: 'root-1' });
    expect(screen.queryByText(/the quoted text/)).not.toBeInTheDocument();
    // The message itself still renders; only the quote is suppressed.
    expect(screen.getByText(/the reply body/)).toBeInTheDocument();
  });

  test('inside the rail, quoting SOMEONE ELSE — shown', () => {
    // A reply-to-person within a thread. The quote is the only thing naming
    // who is being answered, so suppressing it would lose the addressee.
    render(
      <MemoryRouter>
        <V2MessageRow message={msg('m-other', 'someoneelse')} insideThreadRoot="root-1" />
      </MemoryRouter>,
    );
    expect(screen.getByText(/the quoted text/)).toBeInTheDocument();
  });

  test('quoting the root but rendered FLAT in the channel — shown', () => {
    // No rail supplying context. Hiding here strands the reply.
    show({});
    expect(screen.getByText(/the quoted text/)).toBeInTheDocument();
  });

  test('no quote at all is still no quote', () => {
    render(
      <MemoryRouter>
        <V2MessageRow message={{ ...msg('root-1', 'a'), replyTo: null }} insideThreadRoot="root-1" />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/the quoted text/)).not.toBeInTheDocument();
  });

  test('a numeric id from the wire still matches a string root', () => {
    // thread_root_id arrives as a number from PG and rootId is stringified in
    // the view. An === on mixed types would silently never suppress.
    render(
      <MemoryRouter>
        <V2MessageRow message={msg(101, 'rootauthor')} insideThreadRoot="101" />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/the quoted text/)).not.toBeInTheDocument();
  });
});
