import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import axios from '../../utils/axiosConfig';
import { useAuth } from '../../context/AuthContext';

/**
 * F519: links in our emails carry ?em=<kind>.<send id>, a random id that names
 * no one. On a signed-in load the shell reports it once, then takes it off the
 * address, so a refresh or a copied link carries no tag. A signed-out load
 * leaves it alone: sign-in keeps the query in `next`, and the report goes out
 * once they're back. The server checks consent and recipient; the reply is
 * always empty.
 */
const TAG = /^(digest|needs-you|mention)\.[a-f0-9]{24}$/;

export const useEmailReturn = (): void => {
  const { isAuthenticated, currentUser } = useAuth();
  const userId = currentUser?._id;
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    const params = new URLSearchParams(location.search);
    const tag = params.get('em');
    if (tag === null) return;
    if (TAG.test(tag)) {
      axios.post('/api/users/me/email-return', { tag }).catch(() => { /* attribution only */ });
    }
    params.delete('em');
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [isAuthenticated, userId, location, navigate]);
};
