import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import V2Fold from '../components/V2Fold';

const fold = () => screen.queryByText('Body')?.closest('.v2-fold');

describe('V2Fold', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('a fold that starts open renders without an animation class', () => {
    render(<V2Fold open>Body</V2Fold>);
    expect(fold()).toHaveClass('v2-fold');
    expect(fold()).not.toHaveClass('v2-fold--opening');
  });

  test('a fold that starts closed renders nothing', () => {
    render(<V2Fold open={false}>Body</V2Fold>);
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  test('opening mounts the body with the opening class until its animation ends', () => {
    const { rerender } = render(<V2Fold open={false} id="b" className="x">Body</V2Fold>);
    rerender(<V2Fold open id="b" className="x">Body</V2Fold>);
    expect(fold()).toHaveClass('v2-fold--opening');
    expect(screen.getByText('Body')).toHaveAttribute('id', 'b');
    expect(screen.getByText('Body')).toHaveClass('x');
    // The caller's box sits inside the clipping inner, so its padding folds away too.
    expect(screen.getByText('Body').parentElement).toHaveClass('v2-fold__inner');
    fireEvent.animationEnd(fold() as Element);
    expect(fold()).not.toHaveClass('v2-fold--opening');
  });

  test('closing keeps the body mounted and inert until the close animation ends', () => {
    const { rerender } = render(<V2Fold open>Body</V2Fold>);
    rerender(<V2Fold open={false}>Body</V2Fold>);
    expect(fold()).toHaveClass('v2-fold--closing');
    expect(fold()).toHaveAttribute('inert');
    fireEvent.animationEnd(fold() as Element);
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  test('an animation event from inside the body does not close the fold early', () => {
    const { rerender } = render(<V2Fold open><span className="spin">Body</span></V2Fold>);
    rerender(<V2Fold open={false}><span className="spin">Body</span></V2Fold>);
    fireEvent.animationEnd(screen.getByText('Body'));
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  test('a closing fold unmounts on a timer when no animation event comes', () => {
    jest.useFakeTimers();
    const { rerender } = render(<V2Fold open>Body</V2Fold>);
    rerender(<V2Fold open={false}>Body</V2Fold>);
    expect(screen.getByText('Body')).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(200); });
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
  });

  test('reopening while closing cancels the close', () => {
    jest.useFakeTimers();
    const { rerender } = render(<V2Fold open>Body</V2Fold>);
    rerender(<V2Fold open={false}>Body</V2Fold>);
    rerender(<V2Fold open>Body</V2Fold>);
    act(() => { jest.advanceTimersByTime(400); });
    expect(fold()).toHaveClass('v2-fold--opening');
    expect(fold()).not.toHaveAttribute('inert');
  });
});
