import { useEffect, useRef, useState } from 'react';
import { Workbox } from 'workbox-window';
import { trackEvent, trackException } from '../telemetry/appInsights';

export default function UpdatePrompt() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const workboxRef = useRef<Workbox | null>(null);
  const shouldReloadRef = useRef(false);
  const trackedUpdateRef = useRef(false);

  useEffect(() => {
    const handleAppInstalled = () => {
      trackEvent('pwa_installed', { operation: 'pwa_install' });
    };

    window.addEventListener('appinstalled', handleAppInstalled);

    if (!('serviceWorker' in navigator) || import.meta.env.DEV) {
      return () => window.removeEventListener('appinstalled', handleAppInstalled);
    }

    const workbox = new Workbox('/sw.js');
    workboxRef.current = workbox;

    const showRefreshPrompt = () => {
      setNeedRefresh(true);

      if (!trackedUpdateRef.current) {
        trackedUpdateRef.current = true;
        trackEvent('pwa_update_available', { operation: 'pwa_update' });
      }
    };

    const reloadWhenControlling = () => {
      if (shouldReloadRef.current) {
        window.location.reload();
      }
    };

    workbox.addEventListener('waiting', showRefreshPrompt);
    workbox.addEventListener('controlling', reloadWhenControlling);

    void workbox.register().catch((error: unknown) => {
      trackException(error, { operation: 'pwa_register' });
      console.error('Service worker registration failed.', error);
    });

    return () => {
      window.removeEventListener('appinstalled', handleAppInstalled);
      workbox.removeEventListener('waiting', showRefreshPrompt);
      workbox.removeEventListener('controlling', reloadWhenControlling);
      workboxRef.current = null;
    };
  }, []);

  if (!needRefresh) {
    return null;
  }

  const reload = () => {
    shouldReloadRef.current = true;
    workboxRef.current?.messageSkipWaiting();
  };

  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-50 max-w-sm rounded-xl border border-gray-700 bg-gray-900 p-4 text-white shadow-2xl"
    >
      <div className="space-y-3">
        <div>
          <p className="font-semibold">New version available</p>
          <p className="text-sm text-gray-300">Reload to use the latest app version.</p>
        </div>
        <button
          type="button"
          onClick={reload}
          className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-500 focus:ring-2 focus:ring-green-400 focus:ring-offset-2 focus:ring-offset-gray-900 focus:outline-none"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
