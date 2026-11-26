import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import V2DecisionCard from '../components/V2DecisionCard';

const mockPost = jest.fn();

jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ post: mockPost }),
}));

const decision = {
  id: 'decision-1',
  title: 'Choose the workspace cutover',
  detail: 'Which implementation should ship?',
  actorName: 'Sprint impl',
  options: [
    { label: 'Ship the rebuilt workspace', description: 'The full artboard cutover.' },
    { label: 'Keep the legacy chat', recommended: true, description: 'Do not ship the new workspace.' },
  ],
};

describe('V2DecisionCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders a structured fork rather than its prose fallback and posts the chosen option', async () => {
    mockPost.mockResolvedValue({ decision: { ruling: { value: 'Ship the rebuilt workspace', by: 'Sam' } } });
    render(<V2DecisionCard decision={decision} />);

    expect(screen.getByText('Choose the workspace cutover')).toBeInTheDocument();
    expect(screen.getByText('Which implementation should ship?')).toBeInTheDocument();
    expect(screen.getByText('Sprint impl')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ship the rebuilt workspace' })).toHaveClass('v2-decision-card__choice--primary');
    expect(screen.getByRole('button', { name: 'Rule: Keep the legacy chat (Recommended)' })).not.toHaveClass('v2-decision-card__choice--primary');
    const recommendedChoice = screen.getByRole('button', { name: 'Rule: Keep the legacy chat (Recommended)' });
    expect(recommendedChoice).not.toHaveTextContent('Recommended');
    expect(within(recommendedChoice.parentElement as HTMLElement).getByText('Recommended')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Ship the rebuilt workspace' }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/decisions/decision-1/choose',
      { value: 'Ship the rebuilt workspace' },
    ));
    expect(await screen.findByRole('status')).toHaveTextContent('Sam ruled: Ship the rebuilt workspace');
  });

  test('shows the standing ruling from a racing human instead of presenting a second choice', async () => {
    mockPost.mockRejectedValue({
      response: { status: 409, data: { decision: { ruling: { value: 'Keep the legacy chat', by: 'Lily' } } } },
    });
    render(<V2DecisionCard decision={decision} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rule: Keep the legacy chat (Recommended)' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Lily ruled: Keep the legacy chat');
    expect(screen.queryByRole('button', { name: 'Ship the rebuilt workspace' })).not.toBeInTheDocument();
  });

  // ADR-037 Phase 1: a hand-back card offers only its allowed values, needs a
  // reason, and shows what the agent says it changed, checked and did not.
  const handBackCard = {
    id: 'decision-hb',
    title: 'Result: fix the flaky login test',
    actorName: 'claude',
    options: [{ label: 'Accept' }, { label: 'Refuse' }],
    allowedValues: [{ value: 'Accept', reasonRequired: true }, { value: 'Refuse', reasonRequired: true }],
    handBack: {
      status: 'handed_back',
      stage: 'result' as const,
      asked: { text: 'Fix the flaky login test', provenance: 'message' as const, requesterName: 'alice' },
      plan: 'Pin the clock in the login spec.',
      changed: [{ kind: 'pr', ref: 'https://example.com/pull/7', note: 'clock pinned' }],
      checked: [{ what: 'login spec', how: 'ran it 50 times' }],
      unverified: [{ what: 'CI on Windows', why: 'no runner here' }],
      nextAgent: 'codex',
    },
  };

  test('a hand-back card needs a reason, hides Other, and posts the value with the reason', async () => {
    mockPost.mockResolvedValue({ decision: { ruling: { value: 'Accept', by: 'bob', reason: 'Green 50 times' } } });
    render(<V2DecisionCard decision={handBackCard} />);

    expect(screen.getByText('Fix the flaky login test')).toBeInTheDocument();
    expect(screen.getByText('Requester: alice, from the message that asked.')).toBeInTheDocument();
    expect(screen.getByText(/CI on Windows/)).toBeInTheDocument();
    expect(screen.getByText(/ran it 50 times/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.com/pull/7' })).toHaveAttribute('href', 'https://example.com/pull/7');
    expect(screen.getByText('Next: codex')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Other…' })).not.toBeInTheDocument();

    const accept = screen.getByRole('button', { name: 'Accept' });
    expect(accept).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your reason (required)'), { target: { value: '   ' } });
    expect(accept).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your reason (required)'), { target: { value: 'Green 50 times' } });
    expect(accept).not.toBeDisabled();
    fireEvent.click(accept);
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
      '/api/activity/decisions/decision-hb/choose',
      { value: 'Accept', reason: 'Green 50 times' },
    ));
    expect(await screen.findByRole('status')).toHaveTextContent('bob ruled: Accept. Green 50 times');
  });

  test('a ruling that lost to another tab shows the standing reason too', async () => {
    mockPost.mockRejectedValue({
      response: {
        status: 409,
        data: { decision: { ruling: { value: 'Refuse', by: 'bob', reason: 'Fix the race, not the clock' } } },
      },
    });
    render(<V2DecisionCard decision={handBackCard} />);
    fireEvent.change(screen.getByLabelText('Your reason (required)'), { target: { value: 'looks fine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Fix the race, not the clock');
    expect(status).not.toHaveTextContent('looks fine');
  });

  test('a withdrawn card answers that it was withdrawn instead of a generic failure', async () => {
    mockPost.mockRejectedValue({ response: { status: 409, data: { code: 'decision_closed' } } });
    render(<V2DecisionCard decision={handBackCard} />);
    fireEvent.change(screen.getByLabelText('Your reason (required)'), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refuse' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This card was withdrawn. Nothing to rule.');
  });

  test('the owner fallback is labelled as such', () => {
    render(<V2DecisionCard decision={{
      ...handBackCard,
      handBack: { ...handBackCard.handBack, asked: { text: 'Do it', provenance: 'owner' as const, requesterName: 'alice' } },
    }} />);
    expect(screen.getByText("Requester: alice, the agent's owner. No source message.")).toBeInTheDocument();
  });
});
