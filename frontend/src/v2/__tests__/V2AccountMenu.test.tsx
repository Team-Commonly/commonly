// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../../context/AuthContext';
import V2AccountMenu from '../components/V2AccountMenu';

describe('V2AccountMenu avatar', () => {
  test('uses the signed-in human identity and has no online dot', () => {
    const user = {
      _id: 'user-paper-233',
      username: 'Ada',
      profilePicture: 'default',
      role: 'member',
    };
    const auth = {
      currentUser: user,
      user,
      token: null,
      loading: false,
      error: null,
      isAuthenticated: true,
      register: jest.fn(),
      login: jest.fn(),
      logout: jest.fn(),
      updateProfile: jest.fn(),
    };

    const { container } = render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <div className="v2-root"><V2AccountMenu /></div>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(screen.getByRole('button', { name: 'Open account menu' })).toBeInTheDocument();
    const avatar = container.querySelector('.v2-rail__account .v2-avatar');
    expect(avatar).toHaveClass('v2-avatar--md');
    expect(avatar.querySelector('.v2-avatar__online')).toBeNull();
    expect(avatar.querySelector('img')).toHaveAttribute('alt', 'Ada');
    expect(avatar.querySelector('img').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  });
});
