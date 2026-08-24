import React from 'react';
import ReactDOM from 'react-dom/client';
import './utils/axiosConfig'; // Import axios configuration
import './i18n';
import App from './App';
import './App.css'; // Ensure CSS is loaded

if (process.env.REACT_APP_SENTRY_DSN) {
  import('./sentry');
}

// Stamp the v2 canvas BEFORE React renders. Three dark sources layered on
// <body> (App.css bare default — fixed; body.modern-ui — V1-scoped; MUI
// CssBaseline's palette.background.default #0b1220 — injected at render),
// and a class added in V2App's useEffect wins only AFTER first paint, so
// every v2 load still flashed dark for a frame (Sam, 2026-08-24). '/' and
// '/v2*' are the v2 front door; V2App's effect keeps the class in sync for
// SPA navigation after boot. Legacy deep links that redirect into /v2 may
// still flash once — the exception, not the entry path.
const bootPath = window.location.pathname;
if (bootPath === '/' || bootPath.startsWith('/v2')) {
  document.body.classList.add('v2-canvas');
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
