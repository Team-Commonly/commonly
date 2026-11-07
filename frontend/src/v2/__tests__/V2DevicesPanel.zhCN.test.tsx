// @ts-nocheck
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import axios from 'axios';
import i18n, { i18nReady } from '../../i18n';
import V2DevicesPanel from '../components/V2DevicesPanel';

jest.mock('axios', () => {
  const mock = {
    get: jest.fn(), post: jest.fn(), delete: jest.fn(), patch: jest.fn(),
    defaults: { baseURL: '', headers: { common: {} } },
    interceptors: { request: { use: jest.fn(), eject: jest.fn() }, response: { use: jest.fn(), eject: jest.fn() } },
  };
  return { __esModule: true, default: mock, ...mock };
});

const LATIN_WORD = /[A-Za-z]{3,}/;
const device = {
  id: 'd1', label: 'laptop', createdAt: '2026-08-31T10:00:00.000Z', lastUsedAt: '2026-09-01T10:00:00.000Z', revokedAt: null,
};

beforeAll(async () => {
  await i18nReady;
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
});

afterAll(async () => {
  await act(async () => { await i18n.changeLanguage('en'); });
});

afterEach(() => jest.clearAllMocks());

test('the panel, its dates and the revoke confirm read in Chinese', async () => {
  axios.get.mockResolvedValue({ data: { devices: [device] } });
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  render(<V2DevicesPanel />);

  await screen.findByText('laptop');
  expect(screen.getByRole('heading', { name: '设备' })).toBeInTheDocument();
  const meta = screen.getByText(/^创建时间：/);
  expect(meta).toHaveTextContent(new Date(device.createdAt).toLocaleString('zh-CN'));
  expect(meta.textContent).not.toMatch(LATIN_WORD);
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(confirm).toHaveBeenCalledWith('撤销 laptop？这个 CLI 需要重新登录。');
});

test('a device label with a quote stays as typed in the confirm', async () => {
  axios.get.mockResolvedValue({ data: { devices: [{ ...device, label: `sam's "mac"` }] } });
  const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
  render(<V2DevicesPanel />);

  await screen.findByText(`sam's "mac"`);
  fireEvent.click(screen.getByRole('button', { name: '撤销' }));
  expect(confirm).toHaveBeenCalledWith(`撤销 sam's "mac"？这个 CLI 需要重新登录。`);
});

test('the folded summary counts devices in Chinese', async () => {
  axios.get.mockResolvedValue({ data: { devices: [{ ...device, lastUsedAt: null }] } });
  render(<V2DevicesPanel asFold showHeading={false} />);

  expect(await screen.findByText('1台 CLI 设备')).toBeInTheDocument();
});

test('a failed load reads in Chinese', async () => {
  axios.get.mockRejectedValue(new Error('nope'));
  render(<V2DevicesPanel />);

  expect(await screen.findByText('无法加载你的设备。')).toBeInTheDocument();
});
