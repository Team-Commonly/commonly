import React from 'react';
import { render } from '@testing-library/react';
import { HOSTED_MCP_ENTRIES } from '../../../../backend/integrations/hostedMcp/entries';
import { toolInstallableMetas } from '../../../../backend/services/installable/toolInstallables';
import { PLATFORM_GLYPHS, PlatformGlyph } from '../icons/platforms';

// This is a UI/catalogue contract test. The code under test only reads these
// exports, so keep its server-only runtime dependencies inert.
jest.mock('../../../../backend/services/roomGrantService', () => ({
  RoomGrantError: class MockRoomGrantError extends Error {},
}));
jest.mock('../../../../backend/models/Installable', () => ({}));

// Simple Icons marks (CC0), pinned so a re-draw is a visible diff.
const ATLASSIAN_PATH = 'M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z';
const AIRTABLE_PATH = 'M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z';
const LINEAR_PATH = 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z';

describe('platform glyph catalogue contract', () => {
  it('maps every tools-list and hosted-MCP catalogue id to a 20px ink glyph', () => {
    const ids = [...new Set([
      ...Object.keys(toolInstallableMetas()),
      ...HOSTED_MCP_ENTRIES.map(({ id }) => id),
    ])];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !PLATFORM_GLYPHS[id])).toEqual([]);

    const { container } = render(React.createElement(PlatformGlyph, { type: 'linear' }));
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '20');
    expect(svg).toHaveAttribute('height', '20');
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe(LINEAR_PATH);
  });

  it.each([
    ['atlassian', ATLASSIAN_PATH],
    ['airtable', AIRTABLE_PATH],
  ])('renders %s with its Simple Icons mark, in ink, instead of the unknown-platform dot', (type, path) => {
    const { container } = render(React.createElement(PlatformGlyph, { type }));
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '20');
    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe(path);
    expect(svg?.querySelector('circle')).toBeNull();
  });

  it('renders Google Calendar with a calendar mark instead of the unknown-platform dot', () => {
    const { container } = render(React.createElement(PlatformGlyph, { type: 'google-calendar' }));
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '20');
    expect(svg?.querySelector('rect')).toHaveAttribute('x', '3.5');
    expect(svg?.querySelector('rect')).toHaveAttribute('y', '5');
    expect(svg?.querySelector('path')?.getAttribute('d')).toContain('M3.5 10h17');
    expect(svg?.querySelector('circle')).toBeNull();
  });
});
