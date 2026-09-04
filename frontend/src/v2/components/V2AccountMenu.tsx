import React, { useState } from 'react';
import { Popover } from '@mui/material';
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import CableOutlinedIcon from '@mui/icons-material/CableOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import V2Avatar from './V2Avatar';

const V2AccountMenu: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser, logout } = useAuth();
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const v2Root = anchorEl?.closest('.v2-root') as HTMLElement | null;
  const open = Boolean(anchorEl);

  const close = () => setAnchorEl(null);
  const go = (path: string) => {
    navigate(path);
    close();
  };

  return (
    <>
      <button
        type="button"
        className="v2-rail__account"
        aria-label="Open account menu"
        aria-expanded={open}
        aria-controls={open ? 'v2-account-options' : undefined}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        title="Account"
      >
        <V2Avatar name={currentUser?.username || 'You'} size="md" online />
      </button>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={close}
        container={v2Root || undefined}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        PaperProps={{ className: 'v2-account-menu__popover', elevation: 0 }}
      >
        <nav id="v2-account-options" className="v2-account-menu__list" aria-label="Account">
          <button type="button" className="v2-account-menu__item" onClick={() => go('/v2/settings')}>
            <AccountCircleOutlinedIcon aria-hidden="true" />
            <span>Settings</span>
          </button>
          <button type="button" className="v2-account-menu__item" onClick={() => go('/v2/connect')}>
            <CableOutlinedIcon aria-hidden="true" />
            <span>Connect</span>
          </button>
          <button type="button" className="v2-account-menu__item" onClick={() => { logout(); close(); }}>
            <LogoutOutlinedIcon aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </nav>
      </Popover>
    </>
  );
};

export default V2AccountMenu;
