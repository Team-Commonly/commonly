import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import V2NavRail from './V2NavRail';
import V2PodsSidebar from './V2PodsSidebar';
import { V2EmbeddedProvider } from '../hooks/useV2Embedded';
import { useV2PodAttention } from '../hooks/useV2PodAttention';
import V2MobileTabs from './V2MobileTabs';
import V2PageHead from './V2PageHead';

interface V2FeaturePageProps {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  showPodsSidebar?: boolean;
  showHeader?: boolean;
  className?: string;
}

const withV2Prefix = (path: string): string => {
  if (!path || path === '/v2' || path.startsWith('/v2/')) {
    return path || '/v2';
  }
  return path.startsWith('/') ? `/v2${path}` : `/v2/${path}`;
};

// MUI's createTheme cannot read var(), so these stay literal. Each value is the
// light --v2-* token of the same role; V2FeaturePageColors.test pins them to v2.css.
export const V2_COLORS = {
  bg: '#f9fafb',
  surface: '#ffffff',
  surfaceHover: '#f2f4f7',
  border: '#d0d5dd',
  borderSoft: '#e4e7ec',
  borderStrong: '#98a2b3',
  textPrimary: '#101828',
  textSecondary: '#475467',
  textMuted: '#667085',
  accent: '#1d3fd1',
  accentStrong: '#1633a8',
  accentSoft: '#e9edfb',
  success: '#10b981',
  warning: '#f4a23a',
  danger: '#ef4444',
  info: '#0891b2',
  shadowSm: 'none',
  shadow: 'none',
  shadowLg: 'none',
};

const v2FeatureTheme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: V2_COLORS.accent,
      light: '#e9edfb',
      dark: V2_COLORS.accentStrong,
      contrastText: V2_COLORS.surface,
    },
    secondary: {
      main: '#0f2378',
      contrastText: V2_COLORS.surface,
    },
    success: { main: V2_COLORS.success },
    warning: { main: V2_COLORS.warning },
    error: { main: V2_COLORS.danger },
    info: { main: V2_COLORS.info },
    text: {
      primary: V2_COLORS.textPrimary,
      secondary: V2_COLORS.textSecondary,
    },
    background: {
      default: V2_COLORS.bg,
      paper: V2_COLORS.surface,
    },
    divider: V2_COLORS.border,
  },
  typography: {
    fontFamily: [
      '"SF Pro Text"',
      '-apple-system',
      'BlinkMacSystemFont',
      '"SF Pro"',
      '"Helvetica Neue"',
      '"Segoe UI"',
      '"Inter"',
      'Roboto',
      'sans-serif',
    ].join(','),
    button: {
      textTransform: 'none',
      fontWeight: 700,
    },
  },
  shape: {
    borderRadius: 12,
  },
  components: {
    MuiPaper: {
      defaultProps: {
        elevation: 0,
      },
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          borderColor: V2_COLORS.border,
          color: V2_COLORS.textPrimary,
        },
        rounded: {
          borderRadius: 12,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          border: `1px solid ${V2_COLORS.border}`,
          borderRadius: 12,
          boxShadow: V2_COLORS.shadowSm,
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          textTransform: 'none',
          fontWeight: 700,
          boxShadow: 'none',
          minHeight: 34,
        },
        containedPrimary: {
          background: V2_COLORS.accent,
          '&:hover': {
            background: V2_COLORS.accentStrong,
            boxShadow: 'none',
          },
        },
        outlined: {
          borderColor: V2_COLORS.border,
          color: V2_COLORS.accent,
          '&:hover': {
            borderColor: V2_COLORS.borderStrong,
            backgroundColor: V2_COLORS.surfaceHover,
          },
        },
        text: {
          color: V2_COLORS.accent,
          '&:hover': {
            backgroundColor: V2_COLORS.surfaceHover,
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          fontWeight: 700,
          backgroundColor: V2_COLORS.accentSoft,
          color: V2_COLORS.accent,
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        variant: 'outlined',
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          backgroundColor: V2_COLORS.surface,
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: V2_COLORS.accent,
          },
        },
        notchedOutline: {
          borderColor: V2_COLORS.border,
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          color: V2_COLORS.textSecondary,
          '&.Mui-focused': {
            color: V2_COLORS.accent,
          },
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        root: {
          minHeight: 42,
        },
        indicator: {
          backgroundColor: V2_COLORS.accent,
          height: 2,
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 700,
          color: V2_COLORS.textSecondary,
          minHeight: 42,
          '&.Mui-selected': {
            color: V2_COLORS.accent,
          },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          color: V2_COLORS.textMuted,
          borderRadius: 8,
          '&:hover': {
            color: V2_COLORS.textPrimary,
            backgroundColor: V2_COLORS.surfaceHover,
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 16,
          border: `1px solid ${V2_COLORS.border}`,
          boxShadow: V2_COLORS.shadowLg,
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          border: `1px solid ${V2_COLORS.border}`,
          boxShadow: V2_COLORS.shadow,
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          color: V2_COLORS.textPrimary,
          '&:hover': {
            backgroundColor: V2_COLORS.surfaceHover,
          },
          '&.Mui-selected': {
            backgroundColor: V2_COLORS.accentSoft,
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottomColor: V2_COLORS.borderSoft,
          color: V2_COLORS.textPrimary,
        },
        head: {
          color: V2_COLORS.textSecondary,
          fontWeight: 800,
          backgroundColor: V2_COLORS.bg,
        },
      },
    },
    MuiListItem: {
      styleOverrides: {
        root: {
          borderRadius: 10,
        },
      },
    },
    MuiListItemText: {
      styleOverrides: {
        primary: {
          color: V2_COLORS.textPrimary,
          fontWeight: 700,
        },
        secondary: {
          color: V2_COLORS.textSecondary,
        },
      },
    },
  },
});

const V2FeaturePage: React.FC<V2FeaturePageProps> = ({
  title,
  hint,
  children,
  showPodsSidebar = false,
  showHeader = true,
  className = '',
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const attention = useV2PodAttention();

  useEffect(() => {
    try {
      sessionStorage.setItem('commonly.v2.active', '1');
    } catch {
      // Ignore browsers that disallow sessionStorage.
    }
  }, []);

  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
    if (!anchor || anchor.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const url = new URL(anchor.href, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith('/v2')) {
      return;
    }

    event.preventDefault();
    navigate(`${withV2Prefix(url.pathname)}${url.search}${url.hash}`);
  };

  return (
    <div className={`v2-shell${showPodsSidebar ? ' v2-shell--feature' : ' v2-shell--feature-wide'}`}>
      <V2NavRail needsYouCount={attention.count} />
      {showPodsSidebar && <V2PodsSidebar selectedPodId={null} />}
      <main className={`v2-pane v2-pane--main v2-feature${className ? ` ${className}` : ''}`} onClickCapture={handleClickCapture} aria-label={title}>
        {showHeader && <V2PageHead className="v2-feature__header" titleClassName="v2-feature__title" title={title} hint={hint} hintLabel={t('common.aboutPage', { title })} />}
        <section className="v2-feature__body">
          <ThemeProvider theme={v2FeatureTheme}>
            <V2EmbeddedProvider>
              <div className="v2-feature__legacy">
                {children}
              </div>
            </V2EmbeddedProvider>
          </ThemeProvider>
        </section>
      </main>
      <V2MobileTabs needsYouCount={attention.count ?? 0} />
    </div>
  );
};

export default V2FeaturePage;
