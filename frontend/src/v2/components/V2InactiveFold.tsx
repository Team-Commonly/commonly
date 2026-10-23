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
  if (count === 0) return null;

  return (
    <div className="v2-connectors__inactive-fold">
      <button
        type="button"
        className="v2-connectors__inactive-toggle"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="v2-connectors__inactive-caret" aria-hidden="true" />
        {t('connectors.inactiveFold', { defaultValue: 'inactive · {{n}}', n: count })}
      </button>
      {open && <div className="v2-connectors__inactive-rows">{children}</div>}
    </div>
  );
};

export default V2InactiveFold;
