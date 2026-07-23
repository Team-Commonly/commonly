import React, { useState } from 'react';
import { Popover } from '@mui/material';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import FeedbackOutlinedIcon from '@mui/icons-material/FeedbackOutlined';
import LightbulbOutlinedIcon from '@mui/icons-material/LightbulbOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { requestFirstRunGuide } from '../firstRunGuide';
import {
  buildBugReportUrl,
  buildFeatureRequestUrl,
  DISCUSSIONS_QA_URL,
  DISCORD_INVITE_URL,
} from '../utils/feedbackLinks';

const V2FeedbackMenu: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const v2Root = anchorEl?.closest('.v2-root') as HTMLElement | null;
  const open = Boolean(anchorEl);

  const handleOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  return (
    <>
      <button
        type="button"
        className="v2-rail__feedback"
        aria-label={t('feedbackMenu.button')}
        aria-expanded={open}
        aria-controls={open ? 'v2-feedback-options' : undefined}
        onClick={handleOpen}
        title={t('feedbackMenu.button')}
      >
        <FeedbackOutlinedIcon aria-hidden="true" />
      </button>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        container={v2Root || undefined}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        PaperProps={{ className: 'v2-feedback-menu__popover', elevation: 0 }}
      >
        <nav id="v2-feedback-options" className="v2-feedback-menu__list" aria-label={t('feedbackMenu.optionsLabel')}>
          <button
            type="button"
            className="v2-feedback-menu__item"
            onClick={() => { requestFirstRunGuide(); handleClose(); }}
          >
            <MenuBookOutlinedIcon aria-hidden="true" />
            <span>{t('firstRun.reopen')}</span>
          </button>
          <a
            className="v2-feedback-menu__item"
            href={buildBugReportUrl(location.pathname)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleClose}
          >
            <BugReportOutlinedIcon aria-hidden="true" />
            <span>{t('feedbackMenu.actions.reportBug')}</span>
          </a>
          <a
            className="v2-feedback-menu__item"
            href={buildFeatureRequestUrl()}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleClose}
          >
            <LightbulbOutlinedIcon aria-hidden="true" />
            <span>{t('feedbackMenu.actions.requestFeature')}</span>
          </a>
          <a
            className="v2-feedback-menu__item"
            href={DISCUSSIONS_QA_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleClose}
          >
            <QuestionAnswerOutlinedIcon aria-hidden="true" />
            <span>{t('feedbackMenu.actions.askQuestion')}</span>
          </a>
          <a
            className="v2-feedback-menu__item"
            href={DISCORD_INVITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleClose}
          >
            <ForumOutlinedIcon aria-hidden="true" />
            <span>{t('feedbackMenu.actions.joinDiscord')}</span>
          </a>
        </nav>
      </Popover>
    </>
  );
};

export default V2FeedbackMenu;
