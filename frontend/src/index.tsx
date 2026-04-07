import React from 'react';
import ReactDOM from 'react-dom/client';
import './utils/axiosConfig'; // Import axios configuration
import App from './App';
import './App.css'; // Ensure CSS is loaded

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
