/**
 * SideBar search ↔ tabs behavior.
 *
 * Bug: once a search ran, SearchResults replaced the whole sidebar content
 * INCLUDING the TOC/annotations/bookmarks tab bar, and reopening the sidebar
 * resurrected the stale results — the "table of contents disappeared" and
 * there was no way back short of finding the tiny search toggle.
 *
 * Expected behavior now:
 *  1. While search results are showing, the bottom tab bar stays visible and
 *     tapping a tab exits the search view back to that tab.
 *  2. A 'show-sidebar-tab' event (TTS bar TOC/Highlights buttons) opens the
 *     sidebar directly on the tabs view, leaving any search view behind.
 */
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Dependency mocks (before importing the component) ---

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: {},
    appService: {
      hasSafeAreaInset: false,
      hasRoundedWindow: false,
      isMobile: true,
    },
  }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      globalReadSettings: { sideBarWidth: '25%', isSideBarPinned: false },
      globalViewSettings: { isEink: false },
      aiSettings: { enabled: false },
    },
  }),
}));

vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({
    updateAppTheme: vi.fn(),
    safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    systemUIVisible: false,
    statusBarHeight: 0,
  }),
}));

const mockConfig = {
  viewSettings: { sideBarTab: 'toc' } as { sideBarTab: string },
};
const mockSetConfig = vi.fn();

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => ({
      book: { title: 'T', author: 'A' },
      bookDoc: { metadata: { language: 'en' }, toc: [] },
    }),
    getConfig: () => mockConfig,
    setConfig: mockSetConfig,
  }),
}));

const mockClearViewSearch = vi.fn();

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => ({ clearSearch: mockClearViewSearch, goTo: vi.fn() }),
    getViewSettings: () => ({ rtl: false, isEink: false }),
    setHoveredBookKey: vi.fn(),
  }),
}));

const mockSearchNavState: {
  searchTerm: string;
  searchResults: unknown[] | null;
} = { searchTerm: '', searchResults: null };
const mockClearSearch = vi.fn();
const mockSetSearchTerm = vi.fn();

vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({
    sideBarBookKey: 'book-1',
    setSideBarBookKey: vi.fn(),
    getSearchNavState: () => mockSearchNavState,
    setSearchTerm: mockSetSearchTerm,
    clearSearch: mockClearSearch,
    setSideBarVisible: vi.fn(),
  }),
}));

// useSidebar drives visibility with real React state so dispatched events
// re-render the component under test.
vi.mock('@/app/reader/hooks/useSidebar', () => ({
  default: () => {
    const [isSideBarVisible, setSideBarVisible] = useState(false);
    return {
      sideBarWidth: '25%',
      isSideBarPinned: false,
      isSideBarVisible,
      getSideBarWidth: () => '25%',
      setSideBarVisible,
      handleSideBarResize: vi.fn(),
      handleSideBarTogglePin: vi.fn(),
    };
  },
}));

vi.mock('@/hooks/useSwipeToDismiss', () => ({
  useSwipeToDismiss: () => ({
    panelRef: { current: null },
    overlayRef: { current: null },
    panelHeight: { current: 0 },
    handleVerticalDragStart: vi.fn(),
  }),
}));

vi.mock('@/hooks/usePanelResize', () => ({
  usePanelResize: () => ({
    handleResizeStart: vi.fn(),
    handleResizeKeyDown: vi.fn(),
  }),
}));

vi.mock('@/hooks/useShortcuts', () => ({ default: () => {} }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/components/Overlay', () => ({ Overlay: () => null }));

// Stub the heavyweight children; the test cares about WHICH view renders.
vi.mock('@/app/reader/components/sidebar/Header', () => ({
  default: () => <div data-testid='sidebar-header' />,
}));
vi.mock('@/app/reader/components/sidebar/BookCard', () => ({
  default: () => <div data-testid='book-card' />,
}));
vi.mock('@/app/reader/components/sidebar/SearchBar', () => ({
  default: () => <div data-testid='search-bar' />,
}));
vi.mock('@/app/reader/components/sidebar/SearchResults', () => ({
  default: () => <div data-testid='search-results' />,
}));
vi.mock('@/app/reader/components/sidebar/Content', () => ({
  default: () => <div data-testid='sidebar-content' />,
}));

import SideBar from '@/app/reader/components/sidebar/SideBar';
import { eventDispatcher } from '@/utils/event';

describe('SideBar search results and tab access', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSearchNavState.searchTerm = 'fox';
    mockSearchNavState.searchResults = [{ label: 'Chapter 1', subitems: [] }];
    mockConfig.viewSettings.sideBarTab = 'toc';
    mockSetConfig.mockClear();
    mockClearSearch.mockClear();
    mockClearViewSearch.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  const openSearchView = async () => {
    await act(async () => {
      await eventDispatcher.dispatch('search-term', { term: 'fox', bookKey: 'book-1' });
    });
  };

  it('keeps the tab bar visible under search results and exits search on tab tap', async () => {
    render(<SideBar />);
    await openSearchView();

    // Search results replace the content area, but the tab bar must remain.
    expect(screen.getByTestId('search-results')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-content')).toBeNull();
    const tocTab = screen.getByLabelText('TOC');
    expect(tocTab).toBeTruthy();

    await act(async () => {
      fireEvent.click(tocTab);
      vi.runAllTimers();
    });

    // Tapping TOC leaves the search view and lands on the tabs content.
    expect(screen.queryByTestId('search-results')).toBeNull();
    expect(screen.getByTestId('sidebar-content')).toBeTruthy();
    expect(mockConfig.viewSettings.sideBarTab).toBe('toc');
    expect(mockClearViewSearch).toHaveBeenCalled();
  });

  it('opens directly on the requested tab via show-sidebar-tab even when search results exist', async () => {
    render(<SideBar />);
    await openSearchView();
    expect(screen.getByTestId('search-results')).toBeTruthy();

    await act(async () => {
      await eventDispatcher.dispatch('show-sidebar-tab', {
        bookKey: 'book-1',
        tab: 'annotations',
      });
    });

    expect(screen.queryByTestId('search-results')).toBeNull();
    expect(screen.getByTestId('sidebar-content')).toBeTruthy();
    expect(mockConfig.viewSettings.sideBarTab).toBe('annotations');
  });

  it('opens the sidebar on the tabs view when show-sidebar-tab fires while closed', async () => {
    render(<SideBar />);
    // Sidebar starts hidden — nothing rendered.
    expect(screen.queryByTestId('sidebar-content')).toBeNull();

    await act(async () => {
      await eventDispatcher.dispatch('show-sidebar-tab', { bookKey: 'book-1', tab: 'toc' });
    });

    expect(screen.getByTestId('sidebar-content')).toBeTruthy();
    expect(screen.queryByTestId('search-results')).toBeNull();
  });
});
