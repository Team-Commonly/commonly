import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

// An old auth path with no page of its own. NavigationHandler redirects the
// exact path, but the route also matches /login/ and /Login, which it misses:
// render the redirect here too, query included, so those never land blank.
const LegacyAuthRedirect: React.FC<{ to: string }> = ({ to }) => {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
};

export default LegacyAuthRedirect;
