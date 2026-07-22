import React from 'react';
import ReactDOM from 'react-dom/client';
import './utils/axiosConfig'; // Import axios configuration
import './i18n';
import App from './App';
import './App.css'; // Ensure CSS is loaded

if (process.env.REACT_APP_SENTRY_DSN) {
  import('./sentry');
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
