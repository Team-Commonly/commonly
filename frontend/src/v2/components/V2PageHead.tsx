import React from 'react';
import V2Hint from './V2Hint';

interface V2PageHeadProps {
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  titleClassName?: string;
  metaClassName?: string;
  hintLabel?: string;
}

const V2PageHead: React.FC<V2PageHeadProps> = ({
  title, meta, actions, hint, className = '', titleClassName = '', metaClassName = '', hintLabel = 'About this page',
}) => (
  <header className={`v2-page-head${className ? ` ${className}` : ''}`}>
    <div className="v2-page-head__identity">
      <h1 className={titleClassName}>{title}</h1>
      {hint != null && <V2Hint label={hintLabel}>{hint}</V2Hint>}
      {meta != null && <span className={`v2-page-head__meta${metaClassName ? ` ${metaClassName}` : ''}`}>{meta}</span>}
    </div>
    {actions != null && <div className="v2-page-head__actions">{actions}</div>}
  </header>
);

export default V2PageHead;
