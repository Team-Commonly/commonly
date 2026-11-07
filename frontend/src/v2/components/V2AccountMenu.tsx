import React, { useState } from 'react';
import { Popover } from '@mui/material';
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import CableOutlinedIcon from '@mui/icons-material/CableOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import V2Avatar from './V2Avatar';

const V2AccountMenu: React.FC = () => {
  const { t } = useTranslation();
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
        aria-label={t('common.account.open')}
        aria-expanded={open}
        aria-controls={open ? 'v2-account-options' : undefined}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        title={t('common.account.label')}
      >
        <V2Avatar
          name={currentUser?.username || t('common.you')}
          src={currentUser?.profilePicture}
          size="md"
          kind="human"
          seed={currentUser?._id || currentUser?.id}
        />
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
        <nav id="v2-account-options" className="v2-account-menu__list" aria-label={t('common.account.label')}>
          <button type="button" className="v2-account-menu__item" onClick={() => go('/v2/settings')}>
            <AccountCircleOutlinedIcon aria-hidden="true" />
            <span>{t('common.nav.settings')}</span>
          </button>
          <button type="button" className="v2-account-menu__item" onClick={() => go('/v2/connect')}>
            <CableOutlinedIcon aria-hidden="true" />
            <span>{t('common.pageTitle.connect')}</span>
          </button>
          <button type="button" className="v2-account-menu__item" onClick={() => { logout(); close(); }}>
            <LogoutOutlinedIcon aria-hidden="true" />
            <span>{t('common.account.signOut')}</span>
          </button>
        </nav>
      </Popover>
    </>
  );
};

export default V2AccountMenu;
