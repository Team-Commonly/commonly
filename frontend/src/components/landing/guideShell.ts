import { useEffect } from 'react';

export const guidePalette = {
  page: '#f8f8fb',
  surface: '#ffffff',
  surfaceTint: '#f4f3f8',
  border: '#e5e7eb',
  borderSoft: '#eef0f6',
  textPrimary: '#111827',
  textSecondary: '#4b5563',
  textTertiary: '#7b8494',
  accent: '#1d3fd1',
  accentStrong: '#1633a8',
  accentSoft: '#e9edfb',
  accentText: '#1d3fd1',
  accentDeep: '#0f2378',
} as const;

// Text-button state colors must not fall back to the legacy root MUI theme.
export const guideTextButtonSx = {
  color: guidePalette.accentText,
  '&:hover': { backgroundColor: guidePalette.accentSoft },
} as const;

// Guides render outside V2's component tree, so keep their page canvas light
// while the rest of the legacy application continues to use its dark shell.
export const useGuideCanvas = () => {
  useEffect(() => {
    document.body.classList.add('guide-canvas');
    return () => document.body.classList.remove('guide-canvas');
  }, []);
};
