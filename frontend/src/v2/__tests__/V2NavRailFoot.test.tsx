// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2NavRail from '../components/V2NavRail';
import { i18nReady } from '../../i18n';

const mockLogout = jest.fn();

jest.mock('axios');
jest.mock('../components/V2Avatar', () => {
  const MockV2Avatar = () => <span data-testid="avatar" />;
  MockV2Avatar.displayName = 'MockV2Avatar';
  return MockV2Avatar;
});
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    currentUser: { _id: 'user-1', username: 'Sam' },
    logout: mockLogout,
  }),
}));

const renderRail = () => render(
  <MemoryRouter initialEntries={['/v2']}>
    <div className="v2-root">
      <V2NavRail />
    </div>
  </MemoryRouter>,
);

describe('rail foot', () => {
  beforeAll(async () => {
    await i18nReady;
  });

  test('the theme switch sits directly above the avatar, as the frame draws it', () => {
    renderRail();
    const foot = document.querySelector('.v2-rail__foot');
    const kids = [...foot.children];
    const user = foot.querySelector('.v2-rail__user');
    expect(kids[kids.length - 1]).toBe(user);
    expect(user.previousElementSibling).toHaveAttribute('role', 'group');
    expect(user.querySelectorAll('button')).toHaveLength(1);
    expect(screen.queryByTitle('Sign out')).toBeNull();
  });

  test('sign out is one click away in the account menu', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Open account menu' }));
    fireEvent.click(screen.getByText('Sign out').closest('button'));
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });
});
