import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface V2ConfirmOptions {
  message: string;
  confirmLabel: string;
}

interface V2ConfirmRequest extends V2ConfirmOptions {
  input: boolean;
  resolve: (value: string | null) => void;
}

interface V2ConfirmDialogProps {
  request: V2ConfirmRequest;
  onSettle: (value: string | null) => void;
}

const V2ConfirmDialog: React.FC<V2ConfirmDialogProps> = ({ request, onSettle }) => {
  const { t } = useTranslation();
  const messageId = useId();
  const [value, setValue] = useState('');
  const dialogRef = useRef<HTMLFormElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (inputRef.current || cancelRef.current)?.focus();
    return () => previous?.focus?.();
  }, []);

  // On the document, because a click on the dialog's text leaves focus on the page behind it, and
  // Escape and Tab have to work from there too. Capture, because App.tsx blurs the active element
  // on any Escape that reaches the document.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape during Chinese input cancels the composition, not the dialog.
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onSettle(null);
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('input, button'));
      const first = items[0];
      const last = items[items.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onSettle]);

  // React events bubble through a portal, so these stop at the dialog: a modal or form that
  // renders this one must not read a click or a submit here as its own.
  return createPortal((
    <div
      className="v2-root v2-modal__overlay v2-confirm__overlay"
      role="presentation"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onSettle(null);
      }}
    >
      <form
        ref={dialogRef}
        className="v2-modal v2-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={messageId}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSettle(value);
        }}
      >
        <p className="v2-confirm__message" id={messageId}>{request.message}</p>
        {request.input && (
          <input
            ref={inputRef}
            className="v2-confirm__input"
            type="text"
            aria-labelledby={messageId}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <div className="v2-confirm__actions">
          <button ref={cancelRef} type="button" className="v2p-b v2p-b-s v2p-b-sm" onClick={() => onSettle(null)}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="v2p-b v2p-b-p v2p-b-sm">{request.confirmLabel}</button>
        </div>
      </form>
    </div>
  ), document.body);
};

/**
 * The app's own confirm and prompt. A native dialog shows the browser's buttons in the browser's
 * language and names the site in its title, whatever language the app is in.
 *
 * Render `dialog` anywhere in the component, on every path that can reach a call.
 * `confirm` resolves false on cancel, and `prompt` resolves null. A page that stays mounted while
 * it switches subject passes that subject as `subject`, so a question about the old one is cancelled.
 */
export const useV2Confirm = (subject?: string) => {
  const [request, setRequest] = useState<V2ConfirmRequest | null>(null);
  const pending = useRef<V2ConfirmRequest | null>(null);

  const settle = useCallback((value: string | null) => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    setRequest(null);
    current.resolve(value);
  }, []);

  const open = useCallback((options: V2ConfirmOptions, input: boolean) => new Promise<string | null>((resolve) => {
    pending.current?.resolve(null);
    const next = { ...options, input, resolve };
    pending.current = next;
    setRequest(next);
  }), []);

  const confirm = useCallback(
    async (options: V2ConfirmOptions) => (await open(options, false)) !== null,
    [open],
  );
  const prompt = useCallback((options: V2ConfirmOptions) => open(options, true), [open]);

  // Nothing is left waiting on a dialog that went away with its page.
  useEffect(() => () => settle(null), [settle, subject]);

  const dialog = request ? <V2ConfirmDialog request={request} onSettle={settle} /> : null;
  return { confirm, prompt, dialog };
};
