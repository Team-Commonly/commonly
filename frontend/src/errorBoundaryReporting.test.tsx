// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
import { AppErrorBoundary } from './App';
import { V2ErrorBoundary } from './v2/V2App';
import { reportBoundaryError } from './sentryReport';

jest.mock('./sentryReport', () => ({
  __esModule: true,
  reportBoundaryError: jest.fn(),
}));

const crash = new Error('boom from a child');
const Broken = () => { throw crash; };

describe.each([
  ['app', AppErrorBoundary],
  ['v2', V2ErrorBoundary],
])('the %s boundary', (boundary, Boundary) => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    reportBoundaryError.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports what it caught once, tagged with its own name', () => {
    render(<Boundary><Broken /></Boundary>);

    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
    expect(reportBoundaryError).toHaveBeenCalledWith(
      crash,
      expect.objectContaining({ boundary, componentStack: expect.any(String) }),
    );
  });

  it('reports nothing when the child renders', () => {
    render(<Boundary><div>fine</div></Boundary>);

    expect(screen.getByText('fine')).toBeInTheDocument();
    expect(reportBoundaryError).not.toHaveBeenCalled();
  });

  it('still renders its fallback when the helper throws', () => {
    reportBoundaryError.mockImplementation(() => { throw new Error('reporter broke'); });

    render(<Boundary><Broken /></Boundary>);

    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
    expect(screen.getByText('boom from a child')).toBeInTheDocument();
  });
});
