import fs from 'fs';
import path from 'path';

// The v2 stylesheet as the app loads it: v2.css, then each surface file lifted
// out of it (D223), in V2App.tsx's import order. Tests that read "the v2 CSS"
// read this, so a rule keeps its pin when its lift moves it to its own file.
export const V2_CSS_FILES = [
  'v2.css',
  'chat/chat-message.css',
  'chat/chat-pane.css',
  'chat/chat-composer.css',
  'chat/chat-inspector.css',
  'chat/chat-states.css',
];

export const readV2Css = (): string => V2_CSS_FILES
  .map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
  .join('\n');
