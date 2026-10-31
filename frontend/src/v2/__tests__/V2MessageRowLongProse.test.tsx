import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import { CollapsibleProse } from '../components/V2MessageRow';

const setScrollHeight = (px: number) => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => px });
};

describe('CollapsibleProse', () => {
  afterEach(() => {
    setScrollHeight(0);
    return i18n.changeLanguage('en');
  });

  it('folds a long agent message past six lines behind a real Show more button', () => {
    setScrollHeight(900);
    const { container } = render(
      <CollapsibleProse collapsible>
        <div className="v2-msg__content">long reply</div>
      </CollapsibleProse>,
    );
    const wrapper = container.querySelector('.v2-msg__prose');
    expect(wrapper).toHaveClass('v2-msg__prose--closed');
    const button = screen.getByRole('button', { name: 'Show more' });
    expect(button).toHaveClass('v2-msg__showmore');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(wrapper).not.toHaveClass('v2-msg__prose--closed');
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders a short agent message with no fold and no button', () => {
    setScrollHeight(120);
    const { container } = render(
      <CollapsibleProse collapsible>
        <div className="v2-msg__content">short reply</div>
      </CollapsibleProse>,
    );
    expect(container.querySelector('.v2-msg__prose--closed')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('leaves non-agent messages untouched even when they are long', () => {
    setScrollHeight(900);
    const { container } = render(
      <CollapsibleProse collapsible={false}>
        <div className="v2-msg__content">human reply</div>
      </CollapsibleProse>,
    );
    expect(container.querySelector('.v2-msg__prose')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('uses Chinese labels for the fold control', async () => {
    await i18n.changeLanguage('zh-CN');
    setScrollHeight(900);
    render(
      <CollapsibleProse collapsible>
        <div className="v2-msg__content">长回复</div>
      </CollapsibleProse>,
    );
    expect(screen.getByRole('button', { name: '展开' })).toBeInTheDocument();
  });
});
