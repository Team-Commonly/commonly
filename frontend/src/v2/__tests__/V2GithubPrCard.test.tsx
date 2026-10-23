// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
import V2GithubPrCard from '../components/V2GithubPrCard';

test('GitHub PR contributors keep initials when external avatar images are blocked', async () => {
  const previousFetch = global.fetch;
  global.fetch = jest.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        title: 'Guard message images', state: 'open', merged: false, number: 927,
        html_url: 'https://github.com/Team-Commonly/commonly/pull/927',
        commits: 1, additions: 2, deletions: 0, changed_files: 1,
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [{ author: { login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/1' } }],
    });
  try {
    const { container } = render(<V2GithubPrCard owner="Team-Commonly" repo="commonly" number={927} />);
    await screen.findByRole('link', { name: 'Pull request #927: Guard message images' });
    const contributor = container.querySelector('.v2-prcard__avatar');
    expect(contributor).toHaveTextContent('O');
    expect(contributor).not.toHaveAttribute('style');
    expect(container.querySelector('img')).toBeNull();
  } finally {
    global.fetch = previousFetch;
  }
});

// TASK-374. A failed fetch used to return null, and the parent had already
// removed the URL from the text, so the PR link vanished on prod.
test('a PR whose fetch fails renders as a full, clickable link', async () => {
  const previousFetch = global.fetch;
  global.fetch = jest.fn().mockRejectedValue(new Error('rate limited'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    render(<V2GithubPrCard owner="Team-Commonly" repo="commonly" number={374001} />);
    const link = await screen.findByRole('link', { name: 'https://github.com/Team-Commonly/commonly/pull/374001' });
    expect(link).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly/pull/374001');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveClass('v2-prcard--fallback');
  } finally {
    warn.mockRestore();
    global.fetch = previousFetch;
  }
});

test('a PR whose response is not ok also falls back to a full link', async () => {
  const previousFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
  try {
    render(<V2GithubPrCard owner="Team-Commonly" repo="commonly" number={374002} />);
    expect(await screen.findByRole('link', { name: 'https://github.com/Team-Commonly/commonly/pull/374002' }))
      .toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly/pull/374002');
  } finally {
    global.fetch = previousFetch;
  }
});
