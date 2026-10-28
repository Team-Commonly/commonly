// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import V2HarnessPicker from '../components/V2HarnessPicker';
import { HARNESS_WALK_TABLE, HIDDEN_HARNESS_IDS } from '../utils/harnessWalkTable';

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
    expect(within(claude).getByTestId('harness-dot-mac')).toHaveAttribute('data-state', 'walked');
    expect(within(claude).getByTestId('harness-dot-linux')).toHaveAttribute('data-state', 'not-walked');
    expect(within(claude).getByTestId('harness-dot-windows')).toHaveAttribute('data-state', 'not-walked');
  });

  it('marks only DeepSeek Harness as private-pods-only', () => {
    render(<V2HarnessPicker selectedId="claude" onSelect={jest.fn()} />);
    const privateRows = HARNESS_WALK_TABLE.filter((row) => row.privatePodsOnly).map((row) => row.id);
    expect(privateRows).toEqual(['dsh']);
    expect(within(screen.getByTestId('harness-row-dsh')).getByText('private pods only')).toBeInTheDocument();
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
    expect(screen.getByTestId('harness-connects-claude')).toHaveTextContent('one command');
    expect(screen.getByTestId('harness-connects-opencode')).toHaveTextContent('terminal steps');
  });
});
