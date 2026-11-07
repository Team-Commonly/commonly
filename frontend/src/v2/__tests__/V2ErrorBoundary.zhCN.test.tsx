// @ts-nocheck
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import i18n, { i18nReady } from '../../i18n';
import { V2ErrorBoundary } from '../V2App';

const Broken = () => { throw new Error('boom'); };

beforeAll(async () => { await i18nReady; });

afterEach(async () => {
  jest.restoreAllMocks();
  await act(async () => { await i18n.changeLanguage('en'); });
});

test.each([['en', 'Something went wrong'], ['zh-CN', '出了点问题']])('the crash screen reads in %s', async (language, title) => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => { await i18n.changeLanguage(language); });
  render(<V2ErrorBoundary><Broken /></V2ErrorBoundary>);
  expect(screen.getByText(title)).toBeInTheDocument();
});
