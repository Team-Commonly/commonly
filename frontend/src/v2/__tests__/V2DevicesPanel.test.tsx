// @ts-nocheck
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import V2DevicesPanel from '../components/V2DevicesPanel';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

afterEach(() => jest.clearAllMocks());

test('lists a device without exposing its bearer and revokes it in place', async () => {
  axios.get.mockResolvedValue({ data: { devices: [{ id: 'd1', label: 'sam-laptop · commonly-cli', createdAt: '2026-08-31T00:00:00.000Z', lastUsedAt: null, revokedAt: null }] } });
  axios.delete.mockResolvedValue({ data: { message: 'Device revoked' } });
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  render(<V2DevicesPanel />);

  expect(await screen.findByText('sam-laptop · commonly-cli')).toBeInTheDocument();
  expect(screen.queryByText(/cm_[a-f0-9]/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/auth/devices/d1'));
  expect(await screen.findByText(/^Revoked/)).toBeInTheDocument();
});

test('a revoked device shows its revoked date and no Revoke button', async () => {
  axios.get.mockResolvedValue({ data: { devices: [{ id: 'd2', label: 'old-laptop · commonly-cli', createdAt: '2026-08-31T00:00:00.000Z', lastUsedAt: null, revokedAt: '2026-10-20T09:30:00.000Z' }] } });
  render(<V2DevicesPanel />);

  expect(await screen.findByText('old-laptop · commonly-cli')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  expect(screen.getByText(/^Revoked/)).toHaveTextContent(new Date('2026-10-20T09:30:00.000Z').toLocaleString());
});

test('the folded Devices summary updates after revoking a listed device', async () => {
  axios.get.mockResolvedValue({ data: { devices: [{ id: 'd3', label: 'sam-laptop · commonly-cli', createdAt: '2026-08-31T00:00:00.000Z', lastUsedAt: null, revokedAt: null }] } });
  axios.delete.mockResolvedValue({ data: { message: 'Device revoked' } });
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  render(<V2DevicesPanel asFold showHeading={false} />);

  expect(await screen.findByText('1 CLI device')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Devices').closest('summary'));
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
  await waitFor(() => expect(axios.delete).toHaveBeenCalledWith('/api/auth/devices/d3'));
  expect(await screen.findByText('None')).toBeInTheDocument();
});
