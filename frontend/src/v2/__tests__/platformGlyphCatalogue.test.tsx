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
