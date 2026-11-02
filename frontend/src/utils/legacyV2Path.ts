// Old app paths and their place in the v2 shell. NavigationHandler (App.tsx)
// sends any path not under /v2 here first.
export const getV2EquivalentPath = (pathname: string, search: string): string | null => {
  // The query rides along: ?next= is where a sign-in lands, and ?oauthError=
  // is the provider's reason. /login once dropped both.
  if (pathname === '/login') return `/v2/login${search}`;
  if (pathname === '/register' || pathname === '/register/invite-required') return `/v2${pathname}${search}`;
  if (pathname === '/verify-email') return `/v2${pathname}${search}`;
  if (pathname.startsWith('/discord/')) return `/v2${pathname}${search}`;
  if (pathname === '/agents') return `/v2/agents${search}`;
  if (pathname === '/activity') return `/v2/activity${search}`;
  if (pathname === '/profile') return '/v2/settings';
  if (pathname.startsWith('/profile/')) return `/v2${pathname}${search}`;
  if (pathname === '/admin/users') return '/v2/admin/users';
  if (pathname === '/admin/integrations/global') return `/v2${pathname}${search}`;
  if (pathname === '/dev/api' || pathname === '/dev/pod-context') return `/v2${pathname}${search}`;
  if (pathname === '/pods') return `/v2${search}`;
  if (pathname.startsWith('/pods/')) return `/v2${pathname}${search}`;
  if (pathname.startsWith('/chat/')) return `/v2${pathname}${search}`;
  return null;
};
