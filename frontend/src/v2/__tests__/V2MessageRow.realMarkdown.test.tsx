// @ts-nocheck
// TASK-374. The suite maps react-markdown to a mock (moduleNameMapper), which
// echoes its source and so hid two linkify defects. This file loads the real
// package by path and renders the linkified markdown through it, so each href
// asserted here is the one a reader would click.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { linkifyBareUrls, messageMarkdownComponents, prUrlsToRefLinks } from '../components/V2MessageRow';
import V2GithubPrCard from '../components/V2GithubPrCard';

const RealReactMarkdown = jest.requireActual('../../../node_modules/react-markdown/index.js').default;

const linksFor = (content) => {
  const { container, unmount } = render(
    <RealReactMarkdown>{linkifyBareUrls(content)}</RealReactMarkdown>,
  );
  const links = Array.from(container.querySelectorAll('a'))
    .map((a) => ({ text: a.textContent, href: a.getAttribute('href') }));
  unmount();
  return links;
};

describe('bare URL linkification through the real react-markdown', () => {
  it('a closing bracket inside the URL stays one link with the full href', () => {
    expect(linksFor('see https://example.com/a]b now')).toEqual([
      { text: 'https://example.com/a]b', href: 'https://example.com/a%5Db' },
    ]);
  });

  it('a full stop after a URL inside parentheses is not part of the link', () => {
    expect(linksFor('(see https://example.com/guide.)')).toEqual([
      { text: 'https://example.com/guide', href: 'https://example.com/guide' },
    ]);
  });

  it('a repo URL is one full link, not just the first dot', () => {
    expect(linksFor('see https://github.com/Team-Commonly/commonly for the code')).toEqual([
      { text: 'https://github.com/Team-Commonly/commonly', href: 'https://github.com/Team-Commonly/commonly' },
    ]);
  });

  it('a PR URL keeps its full href when the card fetch fails', async () => {
    const previousFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('private repo'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { container } = render(
        <V2GithubPrCard owner="Team-Commonly" repo="commonly" number={374901} />,
      );
      const link = await screen.findByRole('link', { name: 'https://github.com/Team-Commonly/commonly/pull/374901' });
      expect(link).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly/pull/374901');
      expect(container.querySelectorAll('a')).toHaveLength(1);
    } finally {
      warn.mockRestore();
      global.fetch = previousFetch;
    }
  });

  // TASK-382. A PR URL that gets a card is replaced by a short owner/repo#N link,
  // so the sentence keeps its punctuation and words. Checked through the real renderer.
  // TASK-382 review: a PR URL already inside `[label](url)` must not be nested into a second link.
  it('a PR URL that is already a markdown link keeps its label and href', () => {
    const { container, unmount } = render(
      <RealReactMarkdown>{prUrlsToRefLinks('see [the PR](https://github.com/Team-Commonly/commonly/pull/12) now')}</RealReactMarkdown>,
    );
    const links = Array.from(container.querySelectorAll('a'));
    const text = container.textContent;
    unmount();
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe('the PR');
    expect(links[0]).toHaveAttribute('href', 'https://github.com/Team-Commonly/commonly/pull/12');
    expect(text).toBe('see the PR now');
  });

  // TASK-306. react-markdown hands every component its mdast `node`; the
  // renderers must not spread it onto the DOM as node="[object Object]".
  it('rendered links and fenced code carry no node attribute', () => {
    const { container, unmount } = render(
      <RealReactMarkdown components={messageMarkdownComponents}>
        {'see [docs](https://example.com/docs)\n\n```\nconst x = 1;\n```'}
      </RealReactMarkdown>,
    );
    expect(container.querySelector('a')).not.toHaveAttribute('node');
    expect(container.querySelector('pre')).not.toHaveAttribute('node');
    unmount();
  });

  it('a PR URL in a sentence reads as a short ref, with its punctuation intact', () => {
    const { container, unmount } = render(
      <RealReactMarkdown>{prUrlsToRefLinks('Review: https://github.com/Team-Commonly/commonly/pull/12. Then merge.')}</RealReactMarkdown>,
    );
    const text = container.textContent;
    const href = container.querySelector('a')?.getAttribute('href');
    unmount();
    expect(text).toBe('Review: Team-Commonly/commonly#12. Then merge.');
    expect(href).toBe('https://github.com/Team-Commonly/commonly/pull/12');
  });

  it('a PR URL mid-sentence keeps the words around it', () => {
    const { container, unmount } = render(
      <RealReactMarkdown>{prUrlsToRefLinks('see https://github.com/Team-Commonly/commonly/pull/13 for the fix')}</RealReactMarkdown>,
    );
    const text = container.textContent;
    unmount();
    expect(text).toBe('see Team-Commonly/commonly#13 for the fix');
  });
});
