// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
import MessageContent from './MessageContent';

jest.mock('./MarkdownContent', () =>
  function MockMarkdown({ children }) {
    return <div data-testid="markdown">{children}</div>;
  }
);
jest.mock('@mui/material', () => {
  const actual = jest.requireActual('@mui/material');
  return {
    ...actual,
    Dialog: ({ open, children }) => (open ? <div role="dialog">{children}</div> : null),
    DialogContent: ({ children }) => <div>{children}</div>,
  };
});

describe('MessageContent', () => {
  const previousApiUrl = process.env.REACT_APP_API_URL;
  beforeEach(() => { process.env.REACT_APP_API_URL = 'https://api.commonly.me'; });
  afterEach(() => { process.env.REACT_APP_API_URL = previousApiUrl; });
  it('renders nothing when no children', () => {
    const { container } = render(<MessageContent />);
    expect(container.firstChild).toBeNull();
  });

  it('renders plain text via MarkdownContent', () => {
    render(<MessageContent>Hello world</MessageContent>);
    expect(screen.getByTestId('markdown')).toHaveTextContent('Hello world');
  });

  it('leaves a foreign png URL as a link instead of requesting it', () => {
    const content = 'Check this out https://example.com/image.png cool right?';
    render(<MessageContent>{content}</MessageContent>);
    expect(screen.queryByRole('img', { name: 'Shared image' })).toBeNull();
    expect(screen.getByRole('link', { name: 'https://example.com/image.png' })).toHaveAttribute('href', 'https://example.com/image.png');
  });

  it('renders an instance upload in message prose as an image', () => {
    render(<MessageContent>{'Photo: https://api.commonly.me/api/uploads/photo.jpg'}</MessageContent>);
    expect(screen.getByRole('img', { name: 'Shared image' })).toHaveAttribute('src', 'https://api.commonly.me/api/uploads/photo.jpg');
  });

  it('does not render image for non-image URLs', () => {
    render(<MessageContent>{'Visit https://example.com/page.html'}</MessageContent>);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders task card when message contains TASK completion pattern', () => {
    const content = 'TASK-007 completed. Branch: nova/task-007-tests. PR #54 opened.';
    render(<MessageContent>{content}</MessageContent>);
    expect(screen.getByText('TASK-007 completed')).toBeInTheDocument();
    expect(screen.getByText('PR #54')).toBeInTheDocument();
    expect(screen.getByText('nova/task-007-tests')).toBeInTheDocument();
  });

  it('renders task card for done keyword', () => {
    render(<MessageContent>{'TASK-012 done.'}</MessageContent>);
    expect(screen.getByText('TASK-012 completed')).toBeInTheDocument();
  });

  it('does not render task card for unrelated TASK mention', () => {
    render(<MessageContent>{'Working on TASK-007 now'}</MessageContent>);
    expect(screen.queryByText(/TASK-007 completed/)).toBeNull();
  });

  it('renders task card without PR when PR not mentioned', () => {
    render(<MessageContent>{'TASK-021 completed successfully'}</MessageContent>);
    expect(screen.getByText('TASK-021 completed')).toBeInTheDocument();
    expect(screen.queryByText(/PR #/)).toBeNull();
  });

  it('deduplicates repeated image URLs', () => {
    const content = 'https://api.commonly.me/api/uploads/a.png and again https://api.commonly.me/api/uploads/a.png';
    render(<MessageContent>{content}</MessageContent>);
    const imgs = screen.getAllByRole('img', { name: 'Shared image' });
    expect(imgs).toHaveLength(1);
  });
});
