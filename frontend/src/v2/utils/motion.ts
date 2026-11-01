// Shared motion helpers for v2: the reduced-motion read, the view-transition
// wrapper, a CSS-safe view-transition name, and exit presence for surfaces that
// slide out. Durations and curves live in CSS (the --v2-dur* and --v2-ease
// tokens); nothing here picks a timing except the exit safety net below.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}

interface ViewTransitionLike { finished?: Promise<unknown> }
type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => ViewTransitionLike };

// Runs `update` inside document.startViewTransition where the browser has the API
// and the user has not asked for reduced motion. Returns null when it ran the
// update directly, so a caller knows there is nothing to wait for.
export function runViewTransition(update: () => void): ViewTransitionLike | null {
  const doc = typeof document !== 'undefined' ? document as ViewTransitionDocument : null;
  if (!doc?.startViewTransition || prefersReducedMotion()) {
    update();
    return null;
  }
  return doc.startViewTransition(update) || {};
}

// A view-transition-name must be a CSS ident and unique on the page. Task ids are
// free text, so every character outside [A-Za-z0-9-] becomes _<hex>_ ; the
// underscore itself is escaped too, which keeps two different ids from ever
// mapping to one name.
export function viewTransitionName(prefix: string, id: string): string {
  const safe = Array.from(id).map((char) => (
    /[A-Za-z0-9-]/.test(char) ? char : `_${char.codePointAt(0)!.toString(16)}_`
  )).join('');
  return `${prefix}-${safe}`;
}

// The longest exit is --v2-dur (a board card leaving its tab). This only guards
// against an animationend that never comes; the CSS animation sets the real pace.
export const EXIT_SAFETY_MS = 600;

export interface ExitPresence<T> {
  /** What to render: the live value, or the last one while it animates out. */
  shown: T | null;
  /** True while the last value is on its way out. Render it inert. */
  leaving: boolean;
  /** Attach to the element that carries the exit animation. */
  ref: (node: HTMLElement | null) => void;
  /** Wire to that element's onAnimationEnd. */
  onAnimationEnd: (event: { target: EventTarget; currentTarget: EventTarget }) => void;
}

// Keeps a closing surface mounted until its exit animation ends. It unmounts at
// once when reduced motion is on, when the element carries no animation at all
// (so a missing stylesheet can never strand it), and after EXIT_SAFETY_MS in any
// case, because a skipped animation fires no event.
export function useExitPresence<T>(value: T | null): ExitPresence<T> {
  const last = useRef<T | null>(value);
  const node = useRef<HTMLElement | null>(null);
  const [exited, setExited] = useState(value === null);
  const open = value !== null;
  if (open) last.current = value;
  const reduce = !open && !exited && prefersReducedMotion();
  const leaving = !open && !exited && !reduce && last.current !== null;
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;

  const finish = useCallback(() => {
    last.current = null;
    setExited(true);
  }, []);

  useEffect(() => {
    if (open) setExited(false);
  }, [open]);

  useLayoutEffect(() => {
    if (open || exited) return undefined;
    const el = node.current;
    const name = el && typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el).animationName : '';
    if (reduce || !el || !name || name === 'none') {
      finish();
      return undefined;
    }
    const timer = window.setTimeout(finish, EXIT_SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [open, exited, reduce, finish]);

  const ref = useCallback((el: HTMLElement | null) => { node.current = el; }, []);
  const onAnimationEnd = useCallback((event: { target: EventTarget; currentTarget: EventTarget }) => {
    if (event.target !== event.currentTarget || !leavingRef.current) return;
    finish();
  }, [finish]);

  return { shown: open ? value : leaving ? last.current : null, leaving, ref, onAnimationEnd };
}
