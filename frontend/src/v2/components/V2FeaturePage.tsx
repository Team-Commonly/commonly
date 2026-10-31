import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import V2NavRail from './V2NavRail';
import V2PodsSidebar from './V2PodsSidebar';
import { V2EmbeddedProvider } from '../hooks/useV2Embedded';
import { useV2PodAttention } from '../hooks/useV2PodAttention';
import { useV2ResolvedDark } from '../hooks/useV2ResolvedDark';
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
// --v2-* token of the same role in its mode; V2FeaturePageColors.test pins both
// sets to v2.css. The status solids have no dark override, so both sets share them.
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
  onAccent: '#ffffff',
  success: '#10b981',
  warning: '#f4a23a',
  danger: '#ef4444',
  info: '#0891b2',
  shadowSm: 'none',
  shadow: 'none',
  shadowLg: 'none',
};

export const V2_DARK_COLORS: typeof V2_COLORS = {
  bg: '#181e28',
  surface: '#141922',
  surfaceHover: '#1e2531',
  border: '#364051',
  borderSoft: '#262d3a',
  borderStrong: '#5f6979',
  textPrimary: '#e8ebf1',
  textSecondary: '#aeb6c4',
  textMuted: '#8b94a5',
  accent: '#6680ff',
  accentStrong: '#3d5ef2',
  accentSoft: '#1b2546',
  onAccent: '#ffffff',
  success: '#10b981',
  warning: '#f4a23a',
  danger: '#ef4444',
  info: '#0891b2',
  shadowSm: 'none',
  shadow: 'none',
  shadowLg: 'none',
};

type V2Palette = typeof V2_COLORS;

const buildV2FeatureTheme = (c: V2Palette, mode: 'light' | 'dark') => createTheme({
  palette: {
    mode,
    primary: {
      main: c.accent,
      light: c.accentSoft,
      dark: c.accentStrong,
      contrastText: c.onAccent,
    },
    secondary: {
      main: '#0f2378',
      contrastText: c.surface,
    },
    success: { main: c.success },
    warning: { main: c.warning },
    error: { main: c.danger },
    info: { main: c.info },
    text: {
      primary: c.textPrimary,
      secondary: c.textSecondary,
    },
    background: {
      default: c.bg,
      paper: c.surface,
    },
    divider: c.border,
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
          borderColor: c.border,
          color: c.textPrimary,
        },
        rounded: {
          borderRadius: 12,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          border: `1px solid ${c.border}`,
          borderRadius: 12,
          boxShadow: c.shadowSm,
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
          background: c.accent,
          '&:hover': {
            background: c.accentStrong,
            boxShadow: 'none',
          },
        },
        outlined: {
          borderColor: c.border,
          color: c.accent,
          '&:hover': {
            borderColor: c.borderStrong,
            backgroundColor: c.surfaceHover,
          },
        },
        text: {
          color: c.accent,
          '&:hover': {
            backgroundColor: c.surfaceHover,
          },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          fontWeight: 700,
          backgroundColor: c.accentSoft,
          color: c.accent,
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
          backgroundColor: c.surface,
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: c.accent,
          },
        },
        notchedOutline: {
          borderColor: c.border,
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          color: c.textSecondary,
          '&.Mui-focused': {
            color: c.accent,
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
          backgroundColor: c.accent,
          height: 2,
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 700,
          color: c.textSecondary,
          minHeight: 42,
          '&.Mui-selected': {
            color: c.accent,
          },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          color: c.textMuted,
          borderRadius: 8,
          '&:hover': {
            color: c.textPrimary,
            backgroundColor: c.surfaceHover,
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 16,
          border: `1px solid ${c.border}`,
          boxShadow: c.shadowLg,
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          border: `1px solid ${c.border}`,
          boxShadow: c.shadow,
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          color: c.textPrimary,
          '&:hover': {
            backgroundColor: c.surfaceHover,
          },
          '&.Mui-selected': {
            backgroundColor: c.accentSoft,
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottomColor: c.borderSoft,
          color: c.textPrimary,
        },
        head: {
          color: c.textSecondary,
          fontWeight: 800,
          backgroundColor: c.bg,
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
          color: c.textPrimary,
          fontWeight: 700,
        },
        secondary: {
          color: c.textSecondary,
        },
      },
    },
  },
});

const v2FeatureTheme = buildV2FeatureTheme(V2_COLORS, 'light');
const v2DarkFeatureTheme = buildV2FeatureTheme(V2_DARK_COLORS, 'dark');

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
  const dark = useV2ResolvedDark();

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
          <ThemeProvider theme={dark ? v2DarkFeatureTheme : v2FeatureTheme}>
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
