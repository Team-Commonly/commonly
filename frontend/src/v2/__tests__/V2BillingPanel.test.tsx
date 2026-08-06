import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../i18n';
import V2BillingPanel from '../components/V2BillingPanel';

const mockPost = jest.fn();
jest.mock('../hooks/useV2Api', () => ({
  useV2Api: () => ({ post: mockPost, get: jest.fn() }),
}));

const mockUser: { value: unknown } = { value: null };
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ currentUser: mockUser.value }),
}));

const free = { entitlements: { pro: false } };
const pro = { entitlements: { pro: true } };

describe('V2BillingPanel', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser.value = free;
    // jsdom refuses assignment to window.location.href without this.
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: { href: string } }).location = { href: '' };
  });

  afterAll(() => {
    (window as unknown as { location: unknown }).location = originalLocation;
  });

  describe('the tier shown is the one the backend gates on', () => {
    test('a free user sees Free and an upgrade action', () => {
      render(<V2BillingPanel />);
      expect(screen.getByText('Free')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Upgrade to Pro/ })).toBeInTheDocument();
    });

    test('a Pro user sees Pro and a manage action, never an upgrade', () => {
      mockUser.value = pro;
      render(<V2BillingPanel />);
      expect(screen.getByText('Pro')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Manage billing/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Upgrade/ })).not.toBeInTheDocument();
    });

    // `pro: true` is the only truthy value that counts — mirrors the backend's
    // `!== true` check, so a stray truthy never shows a tier the API refuses.
    test('a truthy-but-not-true entitlement still reads as Free', () => {
      mockUser.value = { entitlements: { pro: 'yes' } };
      render(<V2BillingPanel />);
      expect(screen.getByText('Free')).toBeInTheDocument();
    });

    test('a user with no entitlements object reads as Free', () => {
      mockUser.value = {};
      render(<V2BillingPanel />);
      expect(screen.getByText('Free')).toBeInTheDocument();
    });
  });

  describe('upgrading hands off to Stripe and grants nothing locally', () => {
    test('redirects to the returned checkout url', async () => {
      mockPost.mockResolvedValue({ url: 'https://checkout.stripe.com/s/1' });
      render(<V2BillingPanel />);
      fireEvent.click(screen.getByRole('button', { name: /Upgrade to Pro/ }));
      await waitFor(() => {
        expect(window.location.href).toBe('https://checkout.stripe.com/s/1');
      });
      expect(mockPost).toHaveBeenCalledWith('/api/billing/checkout', {});
    });

    test('a configuration error tells the user to contact us, not "try again"', async () => {
      mockPost.mockRejectedValue({ response: { data: { error: 'billing_not_configured' } } });
      render(<V2BillingPanel />);
      fireEvent.click(screen.getByRole('button', { name: /Upgrade to Pro/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/contact us/i);
    });

    test('a transient failure is recoverable and re-enables the button', async () => {
      mockPost.mockRejectedValue(new Error('network'));
      render(<V2BillingPanel />);
      const btn = screen.getByRole('button', { name: /Upgrade to Pro/ });
      fireEvent.click(btn);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      await waitFor(() => expect(btn).not.toBeDisabled());
    });
  });

  test('a pending cancellation is stated without removing access', () => {
    mockUser.value = { entitlements: { pro: true }, billing: { cancelAtPeriodEnd: true } };
    render(<V2BillingPanel />);
    expect(screen.getByText(/set to cancel/i)).toBeInTheDocument();
    // Still Pro until the period ends — the panel must not pre-revoke.
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Manage billing/ })).toBeInTheDocument();
  });
});
