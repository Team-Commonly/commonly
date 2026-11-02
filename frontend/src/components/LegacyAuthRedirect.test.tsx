// @ts-nocheck
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import LegacyAuthRedirect from './LegacyAuthRedirect';

const Where = () => {
  const { pathname, search } = useLocation();
  return <div>{`at ${pathname}${search}`}</div>;
};

// The route matches more than the exact path NavigationHandler redirects.
test.each(['/login', '/login/', '/Login'])('%s lands on /v2/login with its query', (path) => {
  render(
    <MemoryRouter initialEntries={[`${path}?next=%2Fv2%2Fpods%2Fp1`]}>
      <Routes>
        <Route path="/login" element={<LegacyAuthRedirect to="/v2/login" />} />
        <Route path="/v2/login" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByText('at /v2/login?next=%2Fv2%2Fpods%2Fp1')).toBeInTheDocument();
});
