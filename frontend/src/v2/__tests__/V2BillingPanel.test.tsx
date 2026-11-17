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

  test('shows nothing without a Pro entitlement: the paid tier has ended, so there is no upgrade', () => {
    (useAuth as jest.Mock).mockReturnValue({ currentUser: { entitlements: { pro: false } } });
    const { container } = render(<V2BillingPanel />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/upgrade|\$12/i)).not.toBeInTheDocument();
  });

  test('can defer the section heading to Settings without hiding the current tier', () => {
    (useAuth as jest.Mock).mockReturnValue({ currentUser: { entitlements: { pro: true } } });
    render(<V2BillingPanel />);

    expect(screen.queryByRole('heading', { name: 'Plan' })).not.toBeInTheDocument();
    expect(screen.getByText('Pro · $12 a month')).toBeInTheDocument();
  });

  test('sends a Pro account to billing management and never to checkout', async () => {
    (axios.post as jest.Mock).mockRejectedValue(new Error('no redirect in unit test'));
    (useAuth as jest.Mock).mockReturnValue({ currentUser: { entitlements: { pro: true } } });
    render(<V2BillingPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/billing/portal', {}));
    await screen.findByRole('alert');
    expect(axios.post).not.toHaveBeenCalledWith('/api/billing/checkout', expect.anything());
  });
});
