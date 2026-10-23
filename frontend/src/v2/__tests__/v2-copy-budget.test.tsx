import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import fs from 'fs';
import path from 'path';
import V2PageHead from '../components/V2PageHead';

const source = (name: string) => fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');

describe('page head copy budget', () => {
  test('the shared feature header cannot render an eyebrow or sentence description', () => {
    const feature = source('components/V2FeaturePage.tsx');
    const app = source('V2App.tsx');
    expect(feature).not.toMatch(/eyebrow\??:|description\??:|v2-feature__description|v2-feature__eyebrow/);
    expect(app).not.toMatch(/description=\{description\}|description: string/);
    expect(source('components/V2AgentBYO.tsx')).not.toMatch(/eyebrow=|description=/);
    expect(source('components/V2ArtifactsPage.tsx')).not.toContain('v2-artifacts__meta');
    for (const file of ['components/V2ActivityPage.tsx', 'components/V2ConnectorsPage.tsx', 'components/V2Thread.tsx']) {
      expect(source(file)).not.toMatch(/v2-activity__subtitle|v2-connectors__header p|<p>\{pod\.description\}<\/p>/);
    }
  });

  test('details open on hover, focus, and tap without replacing the title or count', () => {
    render(<V2PageHead title="Activity" meta={3} hint="What needs you, then what moved" />);
    const hint = screen.getByRole('button', { name: 'About this page' });
    const detail = screen.getByText('What needs you, then what moved');
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(detail.parentElement).not.toHaveClass('v2-hint--open');
    fireEvent.mouseEnter(hint.parentElement!);
    expect(detail.parentElement).toHaveClass('v2-hint--open');
    fireEvent.mouseLeave(hint.parentElement!);
    expect(detail.parentElement).not.toHaveClass('v2-hint--open');
    fireEvent.focus(hint);
    expect(detail.parentElement).toHaveClass('v2-hint--open');
    fireEvent.blur(hint, { relatedTarget: null });
    expect(detail.parentElement).not.toHaveClass('v2-hint--open');
    fireEvent.pointerDown(hint, { pointerType: 'touch' });
    fireEvent.focus(hint);
    expect(detail.parentElement).not.toHaveClass('v2-hint--open');
    fireEvent.click(hint);
    expect(detail.parentElement).toHaveClass('v2-hint--open');
    fireEvent.click(hint);
    expect(detail.parentElement).not.toHaveClass('v2-hint--open');
  });
});
