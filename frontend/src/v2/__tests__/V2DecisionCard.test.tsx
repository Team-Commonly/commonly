import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByRole('button', { name: 'Keep the legacy chat' })).not.toHaveClass('v2-decision-card__choice--primary');

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

    fireEvent.click(screen.getByRole('button', { name: 'Keep the legacy chat' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Lily ruled: Keep the legacy chat');
    expect(screen.queryByRole('button', { name: 'Ship the rebuilt workspace' })).not.toBeInTheDocument();
  });
});
