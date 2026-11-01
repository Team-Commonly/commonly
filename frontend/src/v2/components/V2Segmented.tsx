import React, { useRef } from 'react';

export interface V2SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  // A count rendered after the label in the muted mono face ("All 64").
  count?: number;
  // Overrides the accessible name when the visible label is not enough.
  ariaLabel?: string;
}

interface V2SegmentedProps<T extends string> {
  options: Array<V2SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
}

/**
 * D215 segmented control: two or three exclusive values side by side. It is a
 * radiogroup, so arrow keys move the choice and only the checked option sits
 * in the tab order.
 */
function V2Segmented<T extends string>({
  options, value, onChange, ariaLabel, size = 'md', disabled = false, className = '',
}: V2SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(0, options.findIndex((option) => option.value === value));

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next].value);
  };

  return (
    <div
      className={['v2p-seg v2-seg', size === 'sm' ? 'v2p-seg--sm v2-seg--sm' : '', className].filter(Boolean).join(' ')}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            tabIndex={index === activeIndex ? 0 : -1}
            disabled={disabled}
            className={`v2-seg__option${checked ? ' on v2-seg__option--on' : ''}`}
            onClick={() => { if (!checked) onChange(option.value); }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
            {typeof option.count === 'number' && <span className="v2-seg__count">{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export default V2Segmented;
