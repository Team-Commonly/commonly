import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import V2Avatar from '../components/V2Avatar';

const svgFromDataUri = (src: string | null): string => decodeURIComponent(
  String(src).replace(/^data:image\/svg\+xml;utf8,/, ''),
);

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

  test('uses Paper for an unpicked human, preserves a stored Cut pick, and lets photos win', () => {
    const { rerender } = render(
      <V2Avatar name="Ada" src="default" kind="human" seed="paper-user" />,
    );

    let image = screen.getByRole('img', { name: 'Ada' });
    let svg = svgFromDataUri(image.getAttribute('src'));
    expect(svg).toContain('M8 64C8 51 18 46 32 46C46 46 56 51 56 64Z');
    expect(svg).not.toMatch(/fill="#(?:ffe4c0|f5d7b1|efcc9f|e2ba87|c99c62|a47539|8c5a2b|643d19)"/);

    rerender(
      <V2Avatar name="Ada" src="bigsmile:paper-user-v13" kind="human" seed="paper-user" />,
    );
    image = screen.getByRole('img', { name: 'Ada' });
    svg = svgFromDataUri(image.getAttribute('src'));
    expect(svg).toContain('fill="#e2ba87"');

    rerender(
      <V2Avatar name="Ada" src="/api/uploads/ada.png" kind="human" seed="paper-user" />,
    );
    expect(screen.getByRole('img', { name: 'Ada' })).toHaveAttribute(
      'src', 'https://api.commonly.me/api/uploads/ada.png',
    );
  });

  test('falls back to Paper when a human photo fails to load', () => {
    render(
      <V2Avatar name="Ada" src="/api/uploads/ada.png" kind="human" seed="paper-user" />,
    );

    fireEvent.error(screen.getByRole('img', { name: 'Ada' }));

    const svg = svgFromDataUri(screen.getByRole('img', { name: 'Ada' }).getAttribute('src'));
    expect(svg).toContain('<ellipse cx="32" cy="29" rx="13" ry="15" fill="#f9fafb"/>');
    expect(svg).not.toMatch(/fill="#(?:ffe4c0|f5d7b1|efcc9f|e2ba87|c99c62|a47539|8c5a2b|643d19)"/);
  });
});
