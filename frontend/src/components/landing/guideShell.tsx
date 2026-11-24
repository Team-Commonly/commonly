import React, { useEffect } from 'react';
import './guide.css';

// Guides render outside V2's component tree, so keep their page canvas light
// while the rest of the legacy application continues to use its dark shell.
export const useGuideCanvas = () => {
  useEffect(() => {
    document.body.classList.add('guide-canvas');
    return () => document.body.classList.remove('guide-canvas');
  }, []);
};

const Arrow: React.FC<{ back?: boolean }> = ({ back }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      fill="currentColor"
      d={back
        ? 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z'
        : 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z'}
    />
  </svg>
);

export const BackArrow: React.FC = () => <Arrow back />;
export const ForwardArrow: React.FC = () => <Arrow />;

// The header every guide page shares: back to the landing page, and the mark.
export const GuideTop: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <div className="guide-top">
    <button type="button" className="guide-btn" onClick={onBack}>
      <BackArrow />
      Back to landing
    </button>
    <span className="guide-brand">
      <img src="/favicon.svg" alt="Commonly Logo" width={26} height={26} />
      Commonly
    </span>
  </div>
);
