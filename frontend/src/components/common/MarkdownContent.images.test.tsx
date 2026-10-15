// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';

jest.mock('react-markdown', () => {
  const ReactForMock = require('react');
  return {
    __esModule: true,
    default: ({ children, components }) => {
      const image = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(String(children));
      return image
        ? ReactForMock.createElement(components.img, { alt: image[1], src: image[2] })
        : ReactForMock.createElement('div', null, children);
    },
  };
});

describe('legacy MarkdownContent image sources', () => {
  const previousApiUrl = process.env.REACT_APP_API_URL;
  beforeEach(() => { process.env.REACT_APP_API_URL = 'https://api.commonly.me'; });
  afterEach(() => { process.env.REACT_APP_API_URL = previousApiUrl; });

  test('foreign markdown image becomes a link with no image request', () => {
    render(<MarkdownContent>{'![chart](https://outside.example/pixel.png?d=secret)'}</MarkdownContent>);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'chart' })).toHaveAttribute('href', 'https://outside.example/pixel.png?d=secret');
  });

  test('same-instance uploads still render', () => {
    render(<MarkdownContent>{'![chart](https://api.commonly.me/api/uploads/chart.png)'}</MarkdownContent>);
    expect(screen.getByRole('img', { name: 'chart' })).toHaveAttribute('src', 'https://api.commonly.me/api/uploads/chart.png');
  });
});
