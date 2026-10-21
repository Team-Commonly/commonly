import React from 'react';
import { render, screen } from '@testing-library/react';
import V2GigCard from '../components/V2GigCard';

const card = (elements: unknown[]) => ({
  id: 'm1', pod_id: 'p1', content: '[GitHub activity]',
  payload: { kind: 'gig-card', source: 'github', elements },
} as never);

test('renders outsider text literally and permits only GitHub HTTPS links', () => {
  const title = '<img src=x onerror=alert(1)> @sprint-impl';
  render(<V2GigCard message={card([
    { type: 'Stack', children: [{ type: 'Badge', text: 'PR opened' }, { type: 'Text', text: title }] },
    { type: 'Link', text: 'Open pull request', href: 'https://github.com/Team-Commonly/commonly/pull/42' },
    { type: 'Link', text: 'Bad link', href: 'https://github.com.evil.example/x' },
  ])} />);
  expect(screen.getByTestId('gig-card')).toBeInTheDocument();
  expect(screen.getByText(title)).toBeInTheDocument();
  expect(screen.getByTestId('gig-card').querySelector('img')).toBeNull();
  expect(screen.getByRole('link', { name: 'Open pull request' })).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly/pull/42');
  expect(screen.queryByText('Bad link')).not.toBeInTheDocument();
});

test('bounds lists and element count', () => {
  render(<V2GigCard message={card([
    { type: 'List', rows: Array.from({ length: 12 }, (_, i) => `Row ${i}`) },
    ...Array.from({ length: 20 }, (_, i) => ({ type: 'Text', text: `Item ${i}` })),
  ])} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(10);
  expect(screen.queryByText('Item 19')).not.toBeInTheDocument();
});

test('rejects a payload exceeding 32 KiB in UTF-8 bytes', () => {
  render(<V2GigCard message={card([{ type: 'Text', text: 'é'.repeat(20 * 1024) }])} />);
  expect(screen.queryByTestId('gig-card')).not.toBeInTheDocument();
});
