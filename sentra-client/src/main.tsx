import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import App from './App';

const isNativeTauri =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

if (!isNativeTauri && typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  registerSW({
    immediate: true,
    onOfflineReady() {
      window.dispatchEvent(new CustomEvent('sentra:sw-offline-ready'));
    },
    onRegisteredSW(_swUrl, registration) {
      if (registration) {
        // Periodically check for updated static asset bundles when online
        window.setInterval(() => {
          if (navigator.onLine) {
            void registration.update().catch(() => {});
          }
        }, 60 * 60 * 1000);
      }
    },
  });
}

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
