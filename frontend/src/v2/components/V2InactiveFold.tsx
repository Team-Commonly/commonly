import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

type V2InactiveFoldProps = {
  count: number;
  children: React.ReactNode;
};

/** Shared collapsed roster for inactive channel and tool connection rows. */
const V2InactiveFold: React.FC<V2InactiveFoldProps> = ({ count, children }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // A closing fold stays mounted until its close animation ends, then unmounts. It is inert while it closes.
  const [closing, setClosing] = useState(false);
  if (count === 0) return null;
  const showBody = open || closing;

  return (
    <div className="v2-connectors__inactive-fold">
      <button
        type="button"
        className="v2-connectors__inactive-toggle"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
            setClosing(true);
          } else {
            setClosing(false);
            setOpen(true);
          }
        }}
      >
        <span className="v2-connectors__inactive-caret" aria-hidden="true" />
        {t('connectors.inactiveFold', { defaultValue: 'inactive · {{n}}', n: count })}
      </button>
      {showBody && (
        <div
          className={`v2-connectors__inactive-fold-body${closing ? ' v2-connectors__inactive-fold-body--closing' : ''}`}
          {...(closing ? { inert: '' } : {})}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && closing) setClosing(false);
          }}
        >
          <div className="v2-connectors__inactive-rows">{children}</div>
        </div>
      )}
    </div>
  );
};

export default V2InactiveFold;
