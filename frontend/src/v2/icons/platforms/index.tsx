// Platform glyphs for connector tiles — single inline SVG per platform, no
// CDN, no PNG (Wren's connectors-v2 spec §2.1). Drawn as simplified marks:
// recognizable at 18px, one brand color via currentColor. Tile tint + brand
// color come from the --v2-platform-* tokens added in the same PR.
import React from 'react';

const S = ({ children }: { children: React.ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {children}
  </svg>
);

const Telegram = () => (
  <S><path d="M21.9 4.1c.3-1.1-.8-2-1.9-1.6L2.7 9.2c-1.2.5-1.1 2.2.1 2.5l4.4 1.2 1.7 5.4c.3 1 1.6 1.3 2.3.5l2.4-2.5 4.5 3.3c.9.7 2.2.2 2.4-.9l3.4-14.6zM9.4 13.6l8.7-6.5c.3-.2.6.2.4.4l-7 6.9-.3 3-1.8-3.8z" /></S>
);

const Slack = () => (
  <S>
    <rect x="9.5" y="2" width="4" height="9" rx="2" transform="rotate(90 11.5 6.5)" />
    <rect x="13" y="9.5" width="9" height="4" rx="2" transform="rotate(90 17.5 11.5)" />
    <rect x="2" y="13" width="9" height="4" rx="2" />
    <rect x="10.5" y="13" width="4" height="9" rx="2" />
  </S>
);

const Discord = () => (
  <S><path d="M19.3 5.3A16.9 16.9 0 0 0 15.1 4l-.5 1a15.5 15.5 0 0 0-5.2 0L8.9 4a16.9 16.9 0 0 0-4.2 1.3C2 9.4 1.3 13.4 1.6 17.3A17 17 0 0 0 6.8 20l1.1-1.8a11 11 0 0 1-1.7-.8l.4-.3a12.2 12.2 0 0 0 10.8 0l.4.3c-.5.3-1.1.6-1.7.8L17.2 20a17 17 0 0 0 5.2-2.7c.4-4.5-.6-8.4-3.1-12zM8.7 14.9c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.9 2.1-1.9 2.1zm6.6 0c-1 0-1.9-1-1.9-2.1s.8-2.1 1.9-2.1 1.9 1 1.9 2.1-.8 2.1-1.9 2.1z" /></S>
);

const WhatsApp = () => (
  <S><path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.2-1.1l-.3-.2-3.1.8.8-3-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4 0-.5.2-.8l.4-.5c.1-.2.1-.4 0-.5l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.9.9-1.2 2.2-.2 3.9a12 12 0 0 0 4.6 4.3c1.8.8 2.5.9 3.4.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2l-.7-.2z" /></S>
);

const XPlatform = () => (
  <S><path d="M17.8 3h3l-6.7 7.7L22 21h-6.2l-4.8-6.3L5.4 21h-3l7.2-8.2L2 3h6.3l4.4 5.8L17.8 3zm-1.1 16h1.7L7.2 4.7H5.4L16.7 19z" /></S>
);

const Instagram = () => (
  <S>
    <path d="M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7z" />
    <path d="M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />
    <circle cx="17.3" cy="6.7" r="1.2" />
  </S>
);

const Messenger = () => (
  <S><path d="M12 2C6.5 2 2 6.1 2 11.2c0 2.9 1.4 5.5 3.7 7.2V22l3.4-1.9c.9.3 1.9.4 2.9.4 5.5 0 10-4.1 10-9.2S17.5 2 12 2zm1.1 12.4-2.6-2.7-5 2.7 5.5-5.8 2.6 2.7 4.9-2.7-5.4 5.8z" /></S>
);

const GroupMe = () => (
  <S><path d="M5 3h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-6.6L8 21.8V18H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zm4.3 4.5-.4 1.8H7l-.3 1.6h1.8l-.4 1.9H6.3L6 14.4h1.8l-.4 1.8h1.7l.4-1.8h1.9l-.4 1.8h1.7l.4-1.8h1.9l.3-1.6H14l.4-1.9h1.8l.3-1.6h-1.8l.4-1.8h-1.7l-.4 1.8h-1.9l.4-1.8H9.3zm1.4 3.4h1.9l-.4 1.9h-1.9l.4-1.9z" /></S>
);

export const PLATFORM_GLYPHS: Record<string, React.FC> = {
  telegram: Telegram,
  slack: Slack,
  discord: Discord,
  whatsapp: WhatsApp,
  x: XPlatform,
  instagram: Instagram,
  messenger: Messenger,
  groupme: GroupMe,
};

export const PlatformGlyph: React.FC<{ type: string }> = ({ type }) => {
  const G = PLATFORM_GLYPHS[type];
  return G ? <G /> : <S><circle cx="12" cy="12" r="9" /></S>;
};
