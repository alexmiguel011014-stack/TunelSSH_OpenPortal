import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './theme.css';

const root = document.getElementById('root');

function showError(msg) {
  root.innerHTML = `
    <div style="height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#f87171;font-family:monospace;padding:40px;">
      <div style="text-align:center;max-width:600px;">
        <h1 style="font-size:24px;margin-bottom:16px;">App Error</h1>
        <pre style="background:#1e293b;padding:16px;border-radius:8px;text-align:left;white-space:pre-wrap;font-size:13px;color:#f87171;">${msg}</pre>
        <p style="color:#64748b;margin-top:16px;font-size:12px;">Check DevTools (F12) for details</p>
      </div>
    </div>
  `;
}

window.addEventListener('error', (e) => {
  console.error('[FATAL]', e.error);
  showError(e.message + '\n\n' + (e.error?.stack || ''));
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[FATAL] Unhandled rejection:', e.reason);
  showError(String(e.reason));
});

try {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} catch (err) {
  console.error('[FATAL] Render failed:', err);
  showError(err.message + '\n\n' + err.stack);
}
