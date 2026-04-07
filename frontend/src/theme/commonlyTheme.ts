import { createTheme, alpha, Theme } from '@mui/material/styles';

interface TokenColors {
  main: string;
  light: string;
  dark: string;
  contrast: string;
}

interface Tokens {
  primary: TokenColors;
  secondary: TokenColors;
  agents: Record<string, string>;
  integrations: Record<string, string>;
  neutral: Record<number, string>;
  success: string;
  warning: string;
  error: string;
  info: string;
  background: { default: string; paper: string; elevated: string; subtle: string };
  shadows: {
    sm: string;
    md: string;
    lg: string;
    xl: string;
    glow: (color: string) => string;
  };
  fonts: { display: string; body: string; mono: string };
  spacing: Record<string, number>;
  radius: Record<string, number>;
  transitions: Record<string, string>;
}

const tokens: Tokens = {
  primary: { main: '#0d9488', light: '#14b8a6', dark: '#0f766e', contrast: '#ffffff' },
  secondary: { main: '#f59e0b', light: '#fbbf24', dark: '#d97706', contrast: '#000000' },
  agents: { personal: '#8b5cf6', utility: '#06b6d4', analytics: '#ec4899', security: '#ef4444', productivity: '#22c55e' },
  integrations: { discord: '#5865F2', slack: '#4A154B', telegram: '#229ED9', whatsapp: '#25D366', github: '#333333' },
  neutral: { 50: '#fafafa', 100: '#f4f4f5', 200: '#e4e4e7', 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b', 700: '#3f3f46', 800: '#27272a', 900: '#18181b', 950: '#09090b' },
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  info: '#3b82f6',
  background: { default: '#fafafa', paper: '#ffffff', elevated: '#ffffff', subtle: '#f4f4f5' },
  shadows: {
    sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
    glow: (color: string) => `0 0 20px ${alpha(color, 0.3)}`,
  },
  fonts: {
    display: '"Cal Sans", "Inter", system-ui, sans-serif',
    body: '"Inter", system-ui, -apple-system, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
  radius: { sm: 6, md: 10, lg: 16, xl: 24, full: 9999 },
  transitions: { fast: '150ms cubic-bezier(0.4, 0, 0.2, 1)', normal: '200ms cubic-bezier(0.4, 0, 0.2, 1)', slow: '300ms cubic-bezier(0.4, 0, 0.2, 1)', bounce: '500ms cubic-bezier(0.34, 1.56, 0.64, 1)' },
};

const commonlyTheme: Theme = createTheme({
  palette: {
    mode: 'light',
    primary: tokens.primary,
    secondary: tokens.secondary,
    success: { main: tokens.success },
    warning: { main: tokens.warning },
    error: { main: tokens.error },
    info: { main: tokens.info },
    background: tokens.background,
    text: { primary: tokens.neutral[900], secondary: tokens.neutral[600], disabled: tokens.neutral[400] },
    divider: tokens.neutral[200],
  } as unknown as Theme['palette'],

  typography: {
    fontFamily: tokens.fonts.body,
    h1: { fontFamily: tokens.fonts.display, fontWeight: 700, fontSize: '2.5rem', lineHeight: 1.2, letterSpacing: '-0.02em' },
    h2: { fontFamily: tokens.fonts.display, fontWeight: 700, fontSize: '2rem', lineHeight: 1.25, letterSpacing: '-0.01em' },
    h3: { fontFamily: tokens.fonts.display, fontWeight: 600, fontSize: '1.5rem', lineHeight: 1.3 },
    h4: { fontFamily: tokens.fonts.display, fontWeight: 600, fontSize: '1.25rem', lineHeight: 1.4 },
    h5: { fontWeight: 600, fontSize: '1.125rem', lineHeight: 1.4 },
    h6: { fontWeight: 600, fontSize: '1rem', lineHeight: 1.5 },
    body1: { fontSize: '1rem', lineHeight: 1.6 },
    body2: { fontSize: '0.875rem', lineHeight: 1.5 },
    caption: { fontSize: '0.75rem', lineHeight: 1.4, color: tokens.neutral[500] },
    button: { fontWeight: 600, textTransform: 'none', letterSpacing: '0.01em' },
  },

  shape: { borderRadius: tokens.radius.md },

  shadows: [
    'none', tokens.shadows.sm, tokens.shadows.sm, tokens.shadows.md, tokens.shadows.md,
    tokens.shadows.md, tokens.shadows.lg, tokens.shadows.lg, tokens.shadows.lg, tokens.shadows.lg,
    tokens.shadows.xl, tokens.shadows.xl, tokens.shadows.xl, tokens.shadows.xl, tokens.shadows.xl,
    tokens.shadows.xl, tokens.shadows.xl, tokens.shadows.xl, tokens.shadows.xl, tokens.shadows.xl,
    tokens.shadows.xl, tokens.shadows.xl, tokens.shadows.xl, tokens.shadows.xl, tokens.shadows.xl,
  ],

  components: {
    MuiCssBaseline: { styleOverrides: { body: { backgroundColor: tokens.background.default, scrollBehavior: 'smooth' }, '::selection': { backgroundColor: alpha(tokens.primary.main, 0.2) }, '::-webkit-scrollbar': { width: 8, height: 8 }, '::-webkit-scrollbar-track': { background: tokens.neutral[100] }, '::-webkit-scrollbar-thumb: { background: tokens.neutral[300], borderRadius: 4 }': {} } },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: tokens.radius.lg, padding: '10px 20px', fontWeight: 600, transition: tokens.transitions.normal, '&:hover': { transform: 'translateY(-1px)' }, '&:active': { transform: 'translateY(0)' } },
        contained: { '&:hover': { boxShadow: tokens.shadows.md } },
        containedPrimary: { background: `linear-gradient(135deg, ${tokens.primary.main} 0%, ${tokens.primary.dark} 100%)`, '&:hover': { background: `linear-gradient(135deg, ${tokens.primary.light} 0%, ${tokens.primary.main} 100%)` } },
        outlined: { borderWidth: 2, '&:hover': { borderWidth: 2, backgroundColor: alpha(tokens.primary.main, 0.04) } },
        text: { '&:hover': { backgroundColor: alpha(tokens.primary.main, 0.08) } },
      },
    },
    MuiCard: { defaultProps: { elevation: 0 }, styleOverrides: { root: { borderRadius: tokens.radius.lg, border: `1px solid ${tokens.neutral[200]}`, transition: tokens.transitions.normal, '&:hover': { borderColor: tokens.neutral[300], boxShadow: tokens.shadows.md } } } },
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: 'none' }, rounded: { borderRadius: tokens.radius.lg }, outlined: { borderColor: tokens.neutral[200] } } },
    MuiChip: { styleOverrides: { root: { borderRadius: tokens.radius.md, fontWeight: 500, transition: tokens.transitions.fast }, filled: { '&:hover': { transform: 'scale(1.02)' } }, outlined: { borderWidth: 1.5 }, colorPrimary: { background: alpha(tokens.primary.main, 0.1), color: tokens.primary.dark, '&:hover': { background: alpha(tokens.primary.main, 0.2) } } } },
    MuiAvatar: { styleOverrides: { root: { fontWeight: 600, fontSize: '1rem' }, rounded: { borderRadius: tokens.radius.md }, colorDefault: { backgroundColor: tokens.primary.main, color: tokens.primary.contrast } } },
    MuiTextField: { defaultProps: { variant: 'outlined', size: 'medium' }, styleOverrides: { root: { '& .MuiOutlinedInput-root': { borderRadius: tokens.radius.md, transition: tokens.transitions.normal, '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: tokens.neutral[400] }, '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: tokens.primary.main, borderWidth: 2 } } } } },
    MuiTab: { styleOverrides: { root: { textTransform: 'none', fontWeight: 600, fontSize: '0.9375rem', minHeight: 48, transition: tokens.transitions.normal, '&.Mui-selected': { color: tokens.primary.main } } } },
    MuiTabs: { styleOverrides: { indicator: { height: 3, borderRadius: '3px 3px 0 0' } } },
    MuiListItem: { styleOverrides: { root: { borderRadius: tokens.radius.md, transition: tokens.transitions.fast, '&:hover': { backgroundColor: alpha(tokens.primary.main, 0.04) } } } },
    MuiTooltip: { styleOverrides: { tooltip: { backgroundColor: tokens.neutral[900], fontSize: '0.8125rem', fontWeight: 500, borderRadius: tokens.radius.sm, padding: '8px 12px' }, arrow: { color: tokens.neutral[900] } } },
    MuiBadge: { styleOverrides: { badge: { fontWeight: 600, fontSize: '0.75rem' }, dot: { width: 10, height: 10, borderRadius: '50%' } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: tokens.radius.xl, boxShadow: tokens.shadows.xl } } },
    MuiMenu: { styleOverrides: { paper: { borderRadius: tokens.radius.lg, boxShadow: tokens.shadows.lg, border: `1px solid ${tokens.neutral[200]}`, marginTop: 8 } } },
    MuiMenuItem: { styleOverrides: { root: { borderRadius: tokens.radius.sm, margin: '2px 8px', padding: '8px 12px', transition: tokens.transitions.fast } } },
    MuiSkeleton: { styleOverrides: { root: { backgroundColor: tokens.neutral[200] }, rounded: { borderRadius: tokens.radius.md } } },
    MuiLinearProgress: { styleOverrides: { root: { borderRadius: tokens.radius.full, height: 6 }, bar: { borderRadius: tokens.radius.full } } },
    MuiSwitch: { styleOverrides: { root: { width: 52, height: 32, padding: 0 }, switchBase: { padding: 4, '&.Mui-checked': { transform: 'translateX(20px)', '& + .MuiSwitch-track': { backgroundColor: tokens.primary.main, opacity: 1 } } }, thumb: { width: 24, height: 24, boxShadow: tokens.shadows.sm }, track: { borderRadius: tokens.radius.full, backgroundColor: tokens.neutral[300], opacity: 1 } } },
  },
});

export { tokens };
export default commonlyTheme;
