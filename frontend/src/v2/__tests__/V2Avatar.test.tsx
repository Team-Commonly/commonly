import React from 'react';
import { render, screen } from '@testing-library/react';
import V2Avatar from '../components/V2Avatar';

describe('V2Avatar', () => {
  const originalApiUrl = process.env.REACT_APP_API_URL;

  beforeEach(() => {
    process.env.REACT_APP_API_URL = 'https://api.commonly.me';
  });

  afterEach(() => {
    if (originalApiUrl === undefined) {
      delete process.env.REACT_APP_API_URL;
    } else {
      process.env.REACT_APP_API_URL = originalApiUrl;
    }
  });

  test('resolves canonical relative upload URLs against the API origin', () => {
    render(<V2Avatar name="Agent Ada" src="/api/uploads/avatar.png" />);

    expect(screen.getByRole('img', { name: 'Agent Ada' })).toHaveAttribute(
      'src',
      'https://api.commonly.me/api/uploads/avatar.png',
    );
  });

  test('leaves data URI avatars unchanged', () => {
    render(<V2Avatar name="Agent Ada" src="data:image/png;base64,avatar" />);

    expect(screen.getByRole('img', { name: 'Agent Ada' })).toHaveAttribute(
      'src',
      'data:image/png;base64,avatar',
    );
  });

  test.each(['human', 'agent'] as const)('keeps a stable Big Smile face in flat %s chat avatars', (kind) => {
    const { rerender } = render(<V2Avatar name="Ada" seed="identity-1" kind={kind} tone="flat" />);
    const source = screen.getByRole('img', { name: 'Ada' }).getAttribute('src');
    expect(source).toMatch(/^data:image\/svg\+xml/);

    rerender(<V2Avatar name="Ada renamed" seed="identity-1" kind={kind} tone="flat" />);
    expect(screen.getByRole('img', { name: 'Ada renamed' })).toHaveAttribute('src', source);
  });
});
