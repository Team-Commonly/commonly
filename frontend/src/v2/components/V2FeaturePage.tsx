import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import V2NavRail from './V2NavRail';
import V2PodsSidebar from './V2PodsSidebar';
import { V2EmbeddedProvider } from '../hooks/useV2Embedded';

interface V2FeaturePageProps {
  eyebrow?: string;
  title: string;
  description?: string;
  children: React.ReactNode;
  showPodsSidebar?: boolean;
  showHeader?: boolean;
}

const withV2Prefix = (path: string): string => {
  if (!path || path === '/v2' || path.startsWith('/v2/')) {
    return path || '/v2';
  }
  return path.startsWith('/') ? `/v2${path}` : `/v2/${path}`;
};

const V2_COLORS = {
  bg: '#f8f8fb',
  surface: '#ffffff',
  surfaceHover: '#f1f2f5',
  border: '#e5e7eb',
  borderSoft: '#eef0f6',
  borderStrong: '#d7dce7',
  textPrimary: '#111827',
  textSecondary: '#4b5563',
  textMuted: '#6b7280',
  accent: '#2f6feb',
  accentStrong: '#1f55c9',
  accentSoft: '#e8efff',
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
      light: '#5b8dff',
      dark: V2_COLORS.accentStrong,
      contrastText: V2_COLORS.surface,
    },
    secondary: {
      main: '#14306f',
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
  eyebrow = 'v2',
  title,
  description,
  children,
  showPodsSidebar = false,
  showHeader = true,
}) => {
  const navigate = useNavigate();

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
      <V2NavRail />
      {showPodsSidebar && <V2PodsSidebar selectedPodId={null} />}
      <main className="v2-pane v2-pane--main v2-feature" onClickCapture={handleClickCapture} aria-label={title}>
        {showHeader && (
          <header className="v2-feature__header">
            <div>
              <div className="v2-feature__eyebrow">{eyebrow}</div>
              <h1 className="v2-feature__title">{title}</h1>
              {description && <p className="v2-feature__description">{description}</p>}
            </div>
          </header>
        )}
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
    </div>
  );
};

export default V2FeaturePage;
