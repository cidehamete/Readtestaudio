/**
 * Utilities for keeping the installed web app (home-screen PWA) on the
 * latest deployed build.
 *
 * iOS ties a home-screen web app's storage to its icon, so "delete and
 * re-add the icon" wipes the library. These helpers make that unnecessary:
 * they only touch the service worker and its HTTP caches — books, reading
 * progress, and highlights live in IndexedDB/OPFS and are never affected.
 */

const hasServiceWorker = () => typeof window !== 'undefined' && 'serviceWorker' in navigator;

/**
 * Ask the browser to re-fetch sw.js. The worker is built with skipWaiting +
 * clientsClaim, so a changed build takes control as soon as it installs and
 * the next launch or reload renders the new code. Cheap no-op when the
 * build hasn't changed; safe to call on every foreground.
 */
export const checkForAppUpdate = async (): Promise<void> => {
  if (!hasServiceWorker()) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((reg) => reg.update()));
  } catch {
    // Offline, or the worker isn't registered yet — nothing to do.
  }
};

/**
 * The in-app "nuclear option": unregister the service worker, delete all of
 * its caches, and reload so every asset is re-fetched from the network. The
 * worker re-registers fresh on the reloaded page.
 */
export const forceAppRefresh = async (): Promise<void> => {
  try {
    if (hasServiceWorker()) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister().catch(() => false)));
    }
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } finally {
    window.location.reload();
  }
};
