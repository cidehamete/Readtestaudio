import { beforeEach } from 'vitest';

// matchMedia mock
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// localStorage guarantee.
//
// jsdom exposes `localStorage` as a getter on the window prototype, but
// several test files replace it on `globalThis` (via Object.defineProperty or
// vi.stubGlobal) and don't always restore it cleanly. Under full-suite
// parallel execution this intermittently leaves `localStorage` undefined when
// a later file's setup/teardown touches it, producing flaky
// "Cannot read properties of undefined (reading 'clear'/'length')" failures
// in files like style-dom and tts-utils.
//
// We defensively guarantee a working, memory-backed localStorage before each
// test. It is only installed when the environment's own localStorage is
// missing or non-functional, so tests that rely on the native jsdom storage
// are unaffected.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } as Storage;
}

function ensureLocalStorage(): void {
  let working = false;
  try {
    const ls = globalThis.localStorage;
    // Touch the API the way tests do; if any of this throws or is absent the
    // storage is considered broken and gets replaced.
    working = !!ls && typeof ls.clear === 'function' && typeof ls.length === 'number';
  } catch {
    working = false;
  }
  if (!working) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      writable: true,
      configurable: true,
    });
  }
}

ensureLocalStorage();
beforeEach(ensureLocalStorage);
