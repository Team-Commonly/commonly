import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import V2MessageBubble from '../components/V2MessageBubble';

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: { username: 'viewer' } }),
}));

describe('V2MessageBubble', () => {
  const previousApiUrl = process.env.REACT_APP_API_URL;

  afterEach(() => {
    process.env.REACT_APP_API_URL = previousApiUrl;
  });

  it('resolves relative uploaded images against the configured API origin', () => {
    process.env.REACT_APP_API_URL = 'https://api.commonly.me';

    render(
      <MemoryRouter>
        <V2MessageBubble
          message={{
            id: '1',
            content: '/api/uploads/avatar.png',
            message_type: 'image',
            user: { username: 'sender' },
          }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('img', { name: 'Uploaded attachment' })).toHaveAttribute(
      'src',
      'https://api.commonly.me/api/uploads/avatar.png',
    );
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://api.commonly.me/api/uploads/avatar.png',
    );
  });
});
