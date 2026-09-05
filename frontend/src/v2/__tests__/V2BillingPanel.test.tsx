import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../i18n';
import { useAuth } from '../../context/AuthContext';
import axios from '../../utils/axiosConfig';
import V2BillingPanel from '../components/V2BillingPanel';

jest.mock('../../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../../utils/axiosConfig', () => ({ __esModule: true, default: { post: jest.fn() } }));

describe('V2BillingPanel', () => {
  afterEach(() => jest.clearAllMocks());

  test('shows the paid Pro plan and its billing-management action', () => {
    (useAuth as jest.Mock).mockReturnValue({ currentUser: { entitlements: { pro: true } } });
    render(<V2BillingPanel />);

    expect(screen.getByText('Pro · $12 a month')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage billing' })).toBeInTheDocument();
    expect(screen.queryByText(/free in beta|included during beta/i)).not.toBeInTheDocument();
  });

  test('shows Free and the $12 monthly upgrade action without a Pro entitlement', () => {
    (useAuth as jest.Mock).mockReturnValue({ currentUser: { entitlements: { pro: false } } });
    render(<V2BillingPanel />);

    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade · $12 a month' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage billing' })).not.toBeInTheDocument();
  });

  test('can defer the section heading to Settings without hiding the current tier', () => {
    (useAuth as jest.Mock).mockReturnValue({ currentUser: { entitlements: { pro: true } } });
    render(<V2BillingPanel showHeading={false} />);

    expect(screen.queryByRole('heading', { name: 'Plan' })).not.toBeInTheDocument();
    expect(screen.getByText('Pro · $12 a month')).toBeInTheDocument();
  });

  test('sends a Free account to checkout and a Pro account to billing management', async () => {
    (axios.post as jest.Mock).mockRejectedValue(new Error('no redirect in unit test'));
    (useAuth as jest.Mock).mockReturnValue({ currentUser: { entitlements: { pro: false } } });
    const { rerender } = render(<V2BillingPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade · $12 a month' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/billing/checkout', {}));
    await screen.findByRole('alert');

    (useAuth as jest.Mock).mockReturnValue({ currentUser: { entitlements: { pro: true } } });
    rerender(<V2BillingPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/billing/portal', {}));
  });
});
