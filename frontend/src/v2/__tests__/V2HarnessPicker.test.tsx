// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import V2HarnessPicker from '../components/V2HarnessPicker';
import { HARNESS_WALK_TABLE, HIDDEN_HARNESS_IDS } from '../utils/harnessWalkTable';
import fs from 'fs';
import path from 'path';

const v2Css = fs.readFileSync(path.join(__dirname, '../v2.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// Body of the first rule whose selector list includes `selector` as a complete selector
// (not a prefix of a longer class name), so grouped selectors match too.
const ruleBody = (selector) => {
  const match = v2Css.match(new RegExp(`${selector}(?![\\w-])[^{}]*\\{([^}]*)\\}`));
  return match ? match[1] : '';
};

afterEach(() => jest.clearAllMocks());

describe('V2HarnessPicker', () => {
  it('renders exactly the walked harnesses from the walk table, in table order', () => {
    render(<V2HarnessPicker selectedId="claude" onSelect={jest.fn()} />);
    const rows = within(screen.getByTestId('harness-picker')).getAllByRole('button');
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(
      HARNESS_WALK_TABLE.map((row) => `harness-row-${row.id}`),
    );
    expect(rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()).join('|')).toContain('Qwen Code');
  });

  it('never renders a harness that has no walk on record', () => {
    render(<V2HarnessPicker selectedId="claude" onSelect={jest.fn()} />);
    HIDDEN_HARNESS_IDS.forEach((id) => {
      expect(screen.queryByTestId(`harness-row-${id}`)).toBeNull();
    });
    expect(screen.queryByText('Hermes')).toBeNull();
    expect(screen.queryByText('goose')).toBeNull();
  });

  it('shows Qwen Code and hides Hermes, per the rev 3 walk table', () => {
    render(<V2HarnessPicker selectedId="claude" onSelect={jest.fn()} />);
    expect(screen.getByTestId('harness-row-qwen')).toBeInTheDocument();
    expect(screen.queryByTestId('harness-row-hermes')).toBeNull();
  });

  it('draws the OS dots from the table: filled when walked, dashed when not', () => {
    render(<V2HarnessPicker selectedId="claude" onSelect={jest.fn()} />);
    const claude = screen.getByTestId('harness-row-claude');
    expect(within(claude).getByTestId('harness-dot-claude-mac')).toHaveAttribute('data-state', 'walked');
    expect(within(claude).getByTestId('harness-dot-claude-linux')).toHaveAttribute('data-state', 'mcp-only');
    expect(within(claude).getByTestId('harness-dot-claude-windows')).toHaveAttribute('data-state', 'mcp-only');
    expect(within(screen.getByTestId('harness-row-codex')).getByTestId('harness-dot-codex-linux')).toHaveAttribute('data-state', 'not-walked');
  });

  it('gives each dot the state class the stylesheet keys on, for every state', () => {
    render(<V2HarnessPicker selectedId="claude" onSelect={jest.fn()} />);
    expect(screen.getByTestId('harness-dot-claude-mac')).toHaveClass('v2-harness-picker__dot--walked');
    expect(screen.getByTestId('harness-dot-claude-linux')).toHaveClass('v2-harness-picker__dot--mcp-only');
    expect(screen.getByTestId('harness-dot-codex-linux')).toHaveClass('v2-harness-picker__dot--not-walked');
    expect(screen.getByTestId('harness-dot-dsh-windows')).toHaveClass('v2-harness-picker__dot--not-offered');
  });

  it('titles each OS dot with why it is filled or dashed', () => {
    render(<V2HarnessPicker selectedId="claude" onSelect={jest.fn()} />);
    expect(screen.getByTestId('harness-dot-claude-mac')).toHaveAttribute('title', 'Walked on Mac');
    expect(screen.getByTestId('harness-dot-claude-linux')).toHaveAttribute('title', 'Linux: connects over MCP only, no @mention listener');
    expect(screen.getByTestId('harness-dot-dsh-windows')).toHaveAttribute('title', 'Not offered on Windows');
  });

  it('keeps the filled and dashed dot rules in v2.css', () => {
    expect(ruleBody('.v2-harness-picker__dot--walked')).toContain('background: var(--v2-ink)');
    expect(ruleBody('.v2-harness-picker__dot--not-walked')).toContain('border: 1px dashed var(--v2-text-tertiary)');
  });

  it('marks only DeepSeek Harness as private-pods-only', () => {
    render(<V2HarnessPicker selectedId="claude" onSelect={jest.fn()} />);
    const privateRows = HARNESS_WALK_TABLE.filter((row) => row.privatePodsOnly).map((row) => row.id);
    expect(privateRows).toEqual(['dsh']);
    expect(within(screen.getByTestId('harness-row-dsh')).getByRole('img', { name: 'private pods only' })).toBeInTheDocument();
  });

  it('marks the selected row and reports the id it picks', () => {
    const onSelect = jest.fn();
    render(<V2HarnessPicker selectedId="codex" onSelect={onSelect} />);
    expect(screen.getByTestId('harness-row-codex')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('harness-row-claude')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('harness-row-opencode'));
    expect(onSelect).toHaveBeenCalledWith('opencode');
  });

  it('uses the connect method from the table for each row', () => {
    render(<V2HarnessPicker selectedId="claude" onSelect={jest.fn()} />);
    expect(screen.getByTestId('harness-connects-claude')).toHaveAttribute('aria-label', 'one command');
    expect(screen.getByTestId('harness-connects-opencode')).toHaveAttribute('aria-label', 'terminal steps');
  });
});
