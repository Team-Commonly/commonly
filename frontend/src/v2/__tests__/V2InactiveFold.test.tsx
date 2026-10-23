import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import V2InactiveFold from '../components/V2InactiveFold';

beforeAll(async () => { await i18nReady; });
afterEach(async () => { await act(async () => { await i18n.changeLanguage('en'); }); });

test('inactive rows are hidden until the shared count fold opens', async () => {
  await act(async () => { await i18n.changeLanguage('en'); });
  render(<V2InactiveFold count={2}><span>Revoked grant</span><span>Expired grant</span></V2InactiveFold>);

  const toggle = screen.getByRole('button', { name: 'inactive · 2' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('Revoked grant')).not.toBeInTheDocument();

  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Revoked grant')).toBeInTheDocument();
  expect(screen.getByText('Expired grant')).toBeInTheDocument();

  fireEvent.click(toggle);
  expect(screen.queryByText('Revoked grant')).not.toBeInTheDocument();
});

test('the count label follows the Chinese locale', async () => {
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
  render(<V2InactiveFold count={9}><span>Inactive item</span></V2InactiveFold>);
  expect(screen.getByRole('button', { name: '非活跃 · 9' })).toBeInTheDocument();
});
