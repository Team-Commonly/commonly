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
  accent: '#2f6feb',
  accentStrong: '#1f55c9',
  accentSoft: '#e8efff',
  accentText: '#2456c8',
  accentDeep: '#14306f',
} as const;

// Guides render outside V2's component tree, so keep their page canvas light
// while the rest of the legacy application continues to use its dark shell.
export const useGuideCanvas = () => {
  useEffect(() => {
    document.body.classList.add('guide-canvas');
    return () => document.body.classList.remove('guide-canvas');
  }, []);
};
