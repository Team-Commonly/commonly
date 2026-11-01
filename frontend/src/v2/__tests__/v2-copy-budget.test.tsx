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
    for (const file of [
      'components/V2ActivityPage.tsx',
      'connectors/ConnectorsPage.tsx',
      'connectors/ChannelPanel.tsx',
      'connectors/ToolPanels.tsx',
      'components/V2Thread.tsx',
    ]) {
      expect(source(file)).not.toMatch(/v2-activity__subtitle|v2-connectors__header p|<p>\{pod\.description\}<\/p>/);
    }
  });

  test('details open on hover, focus, and tap without replacing the title or count', () => {
    render(<V2PageHead title="Activity" meta={3} hint="What needs you, then what moved" />);
    const hint = screen.getByRole('button', { name: 'About this page' });
    const detail = screen.getByText('What needs you, then what moved');
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(hint.compareDocumentPosition(screen.getByText('3')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  test('phone disclosure keeps its trigger in the title row and uses the shared focus ring', () => {
    const css = source('v2.css');
    expect(css).toContain('.v2-page-head__identity .v2-hint--open,\n  .v2-thread__title-line .v2-hint--open { display: contents; }');
    expect(css).toContain('.v2-thread__title-line { display: flex; flex-wrap: wrap; align-items: center; }');
    expect(css).toContain('.v2-thread__title-line .v2-hint__content { width: 100%; flex-basis: 100%; order: 1; }');
    expect(css).toMatch(/\.v2-pod-header \.v2-thread__header-row \{[^}]*padding: 11px 0;[^}]*align-items: flex-start;/);
    expect(css).toContain('.v2-pod-header__meta.v2-pod-header__meta--compact { display: flex; min-height: 28px; flex: 0 0 auto; white-space: nowrap; }');
    expect(css).toContain('box-shadow: var(--v2-focus-ring);');
  });
});
