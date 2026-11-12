import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useUsageEvents } from '../hooks/useUsageEvents';
import { reportSettingsReadFailed, setUsageEventsEnabled } from '../utils/usageEvents';

jest.mock('../../utils/axiosConfig', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, currentUser: { _id: 'u1' } }),
}));
jest.mock('../utils/usageEvents', () => ({
  forgetUsageEvents: jest.fn(),
  reportSettingsReadFailed: jest.fn(),
  setUsageEventsEnabled: jest.fn(),
  trackUsage: jest.fn(),
}));

const get = axios.get as jest.Mock;
const Probe: React.FC = () => { useUsageEvents(); return null; };
const mount = () => render(<MemoryRouter><Probe /></MemoryRouter>);

// F399: a Settings read that fails is counted by the client, since that load
// then records nothing; a read that works counts nothing.
describe('useUsageEvents', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads the setting and reports nothing when the read works', async () => {
    get.mockResolvedValue({ data: { usageEvents: true, browserSignal: false } });
    mount();
    await waitFor(() => expect(setUsageEventsEnabled).toHaveBeenCalledWith(true));
    expect(get).toHaveBeenCalledWith('/api/users/me/usage-events');
    expect(reportSettingsReadFailed).not.toHaveBeenCalled();
  });

  it('turns recording off and reports a failed read', async () => {
    get.mockRejectedValue(new Error('network'));
    mount();
    await waitFor(() => expect(reportSettingsReadFailed).toHaveBeenCalledTimes(1));
    expect(setUsageEventsEnabled).toHaveBeenCalledWith(false);
  });
});
