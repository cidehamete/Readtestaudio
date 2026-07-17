/**
 * appUpdate utilities — the data-safe way to get the installed PWA onto the
 * latest deploy. forceAppRefresh must only touch the service worker and the
 * Cache Storage API (books live in IndexedDB/OPFS), and must always reload
 * even when those APIs fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForAppUpdate, forceAppRefresh } from '@/utils/appUpdate';

const mockReload = vi.fn();
const mockUpdate = vi.fn().mockResolvedValue(undefined);
const mockUnregister = vi.fn().mockResolvedValue(true);
const mockGetRegistrations = vi
  .fn()
  .mockResolvedValue([{ update: mockUpdate, unregister: mockUnregister }]);
const mockCacheKeys = vi.fn().mockResolvedValue(['client-pages', 'offline-cache']);
const mockCacheDelete = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, 'serviceWorker', {
    value: { getRegistrations: mockGetRegistrations },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'caches', {
    value: { keys: mockCacheKeys, delete: mockCacheDelete },
    configurable: true,
  });
  Object.defineProperty(window, 'location', {
    value: { reload: mockReload },
    configurable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window.navigator, 'serviceWorker');
  Reflect.deleteProperty(globalThis, 'caches');
});

describe('checkForAppUpdate', () => {
  it('asks every registration to update', async () => {
    await checkForAppUpdate();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('swallows update errors (e.g. offline)', async () => {
    mockUpdate.mockRejectedValueOnce(new Error('offline'));
    await expect(checkForAppUpdate()).resolves.toBeUndefined();
  });

  it('is a no-op without service worker support', async () => {
    Reflect.deleteProperty(window.navigator, 'serviceWorker');
    await expect(checkForAppUpdate()).resolves.toBeUndefined();
    expect(mockGetRegistrations).not.toHaveBeenCalled();
  });
});

describe('forceAppRefresh', () => {
  it('unregisters workers, deletes all caches, then reloads', async () => {
    await forceAppRefresh();
    expect(mockUnregister).toHaveBeenCalledTimes(1);
    expect(mockCacheDelete).toHaveBeenCalledWith('client-pages');
    expect(mockCacheDelete).toHaveBeenCalledWith('offline-cache');
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when cache deletion throws', async () => {
    mockCacheKeys.mockRejectedValueOnce(new Error('quota'));
    await forceAppRefresh().catch(() => {});
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('never touches indexedDB', async () => {
    const idbSpy = vi.fn();
    Object.defineProperty(window, 'indexedDB', {
      value: { deleteDatabase: idbSpy, databases: idbSpy },
      configurable: true,
    });
    await forceAppRefresh();
    expect(idbSpy).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, 'indexedDB');
  });
});
