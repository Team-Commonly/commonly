// The d215 artboard's connector logos: a 40px mark that carries the name, so a
// tile needs no label above it. Brand fills are the artboard's own; the two that
// follow the theme (GitHub's disc and its glyph) read the v2 tokens.
import React from 'react';
import { PlatformGlyph } from '../icons/platforms';

const LOGOS: Record<string, React.ReactNode> = {
  slack: (
    <>
      <rect x="17" y="4" width="6" height="15" rx="3" fill="#36C5F0" />
      <rect x="21" y="17" width="15" height="6" rx="3" fill="#2EB67D" />
      <rect x="17" y="21" width="6" height="15" rx="3" fill="#ECB22E" />
      <rect x="4" y="17" width="15" height="6" rx="3" fill="#E01E5A" />
    </>
  ),
  telegram: (
    <>
      <circle cx="20" cy="20" r="17" fill="#2AABEE" />
      <path d="M10.5 19.6 27.8 12.8c.8-.3 1.5.2 1.3 1.4l-2.9 13.8c-.2 1-.8 1.2-1.6.8l-4.4-3.3-2.1 2c-.2.2-.4.4-.9.4l.3-4.5 8.2-7.4c.4-.3-.1-.5-.5-.2l-10.1 6.4-4.4-1.4c-1-.3-1-1 .2-1.4z" fill="#fff" />
    </>
  ),
  github: (
    <>
      <circle cx="20" cy="20" r="17" fill="var(--v2-ink)" />
      <path d="M20 10.5c-5.2 0-9.4 4.2-9.4 9.4 0 4.2 2.7 7.7 6.4 8.9.5.1.6-.2.6-.5v-1.7c-2.6.6-3.2-1.2-3.2-1.2-.4-1.1-1-1.4-1-1.4-.9-.6.1-.6.1-.6.9.1 1.4 1 1.4 1 .8 1.4 2.2 1 2.7.8.1-.6.3-1 .6-1.2-2.1-.2-4.3-1-4.3-4.6 0-1 .4-1.9 1-2.5-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.7 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.5 1 2.5 0 3.6-2.2 4.4-4.3 4.6.3.3.6.9.6 1.7v2.6c0 .3.2.6.7.5a9.4 9.4 0 0 0-3-18.3z" fill="var(--v2-surface)" />
    </>
  ),
  linear: (
    <>
      <circle cx="20" cy="20" r="16" fill="#5E6AD2" />
      <path d="M8 22.5 17.5 32M7.4 18 22 32.6M9 13.5 26.5 31M12.2 10 30 27.8M16.5 8 32 23.5" stroke="#fff" strokeWidth="1.6" opacity=".9" fill="none" />
    </>
  ),
  atlassian: (
    <>
      <path d="M13.2 19.4c-.4-.5-1.1-.4-1.4.2L5.3 32.5c-.3.6.1 1.3.8 1.3h9.1c.3 0 .6-.2.8-.5 2-4.1.8-10.3-2.8-13.9z" fill="#2684FF" />
      <path d="M18 7.6c-3.5 5.6-3.3 11.7-1 16.4l4.4 8.9c.2.3.5.5.8.5h9.1c.7 0 1.1-.7.8-1.3L19.4 7.6c-.3-.6-1.1-.6-1.4 0z" fill="#0052CC" />
    </>
  ),
  airtable: (
    <>
      <path d="M18 6.5 6 11.4c-.7.3-.7 1.3 0 1.6l12.1 4.8c1.2.5 2.6.5 3.8 0L34 13c.7-.3.7-1.3 0-1.6L22 6.5c-1.3-.5-2.7-.5-4 0z" fill="#FCB400" />
      <path d="M21 20.3v12.2c0 .6.6 1 1.2.8l13.4-5.2c.4-.1.6-.5.6-.8V15.1c0-.6-.6-1-1.2-.8L21.6 19.5c-.4.2-.6.5-.6.8z" fill="#18BFFF" />
      <path d="M18.1 20.9 4.8 27.3c-.6.3-1.3-.1-1.3-.8V15.4c0-.3.1-.5.3-.7l.4-.2c.4-.2.9-.2 1.3 0l12.5 4.9c.7.3.8 1.3.1 1.5z" fill="#F82B60" />
    </>
  ),
  sentry: (
    <>
      <rect x="3" y="3" width="34" height="34" rx="9" fill="#362D59" />
      <path d="M21.6 11.2a1.9 1.9 0 0 0-3.2 0l-2.6 4.6a13 13 0 0 1 7.2 10.7h-1.9a11.1 11.1 0 0 0-6.2-9l-2.4 4.2a6.4 6.4 0 0 1 3.6 4.8h-4.4a.3.3 0 0 1-.3-.5l1.2-2.1a4.4 4.4 0 0 0-1.4-.8l-1.2 2.1a1.9 1.9 0 0 0 .7 2.6c.3.2.6.2.9.2h5.9a8 8 0 0 0-3.3-7l.9-1.6a9.7 9.7 0 0 1 4.3 8.6h5a14.6 14.6 0 0 0-6.7-12.9l1.9-3.3c.1-.1.3-.2.4-.1.2.1 8.2 14 8.3 14.2.1.2 0 .3-.2.3h-1.9v1.6h1.9c1.1 0 1.9-.8 1.9-1.9 0-.3-.1-.7-.3-.9z" fill="#fff" />
    </>
  ),
};

// The connector id a catalog row uses is not always the logo's name.
const ALIASES: Record<string, string> = { 'github-mcp': 'github' };

interface Props {
  type: string;
  size?: number;
}

/** The artboard's logo when there is one; otherwise the platform glyph on a soft disc, so every tile has a mark. */
const ConnectorLogo: React.FC<Props> = ({ type, size = 40 }) => {
  const key = ALIASES[type] || type;
  const mark = LOGOS[key];
  if (mark) {
    return (
      <svg className="v2-cx-logo" viewBox="0 0 40 40" width={size} height={size} aria-hidden="true" focusable="false">{mark}</svg>
    );
  }
  return (
    <span className="v2-cx-logo v2-cx-logo--glyph" style={{ width: size, height: size }} aria-hidden="true"><PlatformGlyph type={type} /></span>
  );
};

export default ConnectorLogo;
