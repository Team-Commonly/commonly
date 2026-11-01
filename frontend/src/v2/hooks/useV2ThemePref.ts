import { useSyncExternalStore } from 'react';
import { getV2Theme, subscribeV2Theme, V2ThemePref } from '../utils/theme';

// The stored theme preference, re-read whenever setV2Theme changes it.
export default function useV2ThemePref(): V2ThemePref {
  return useSyncExternalStore(subscribeV2Theme, getV2Theme, () => 'auto');
}
