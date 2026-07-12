import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Dependency mocks (must be set up before importing the hook) ---

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    appService: { isIOSApp: false, isMobile: false },
    envConfig: {},
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ isDarkMode: false }),
}));

const mockView = {
  book: { primaryLanguage: 'en', sections: [{ id: 0 }, { id: 1 }] },
  renderer: {
    getContents: () => [{ index: 0, doc: document as unknown as Document }],
    scrollToAnchor: vi.fn(),
    primaryIndex: 0,
    scrolled: false,
    nextSection: vi.fn(),
    start: 0,
    end: 0,
    sideProp: 'height',
    goTo: vi.fn(),
  },
  resolveCFI: vi.fn().mockReturnValue({ index: 0, anchor: () => new Range() }),
  getCFI: vi.fn().mockReturnValue('cfi'),
  addAnnotation: vi.fn(),
  deselect: vi.fn(),
  resolveNavigation: vi.fn(),
  history: { back: vi.fn(), forward: vi.fn() },
  tts: {
    from: vi.fn().mockReturnValue('<speak>hello</speak>'),
    start: vi.fn().mockReturnValue('<speak>hello</speak>'),
    getLastRange: vi.fn().mockReturnValue(null),
    highlight: vi.fn(),
  },
};

const mockProgress = {
  location: { start: { cfi: '' }, end: { cfi: '' } },
  index: 0,
  page: 3,
  range: null,
  sectionLabel: '',
};

const mockViewSettings = {
  ttsLocation: null as string | null,
  ttsRate: 1,
  ttsHighlightOptions: { style: 'highlight', color: '#ffff00' },
  isEink: false,
  showTTSBar: false,
  ttsMediaMetadata: 'sentence',
  translationEnabled: false,
  ttsReadAloudText: 'source',
};

const mockBookData = {
  isFixedLayout: false,
  book: { primaryLanguage: 'en', title: 'T', author: 'A', coverImageUrl: '' },
};

vi.mock('@/store/readerStore', () => {
  const store = {
    hoveredBookKey: null,
    getView: () => mockView,
    getViewsById: () => [mockView],
    getProgress: () => mockProgress,
    getViewSettings: () => mockViewSettings,
    setViewSettings: vi.fn(),
    setTTSEnabled: vi.fn(),
  };
  const useReaderStore = () => store;
  useReaderStore.getState = () => store;
  return { useReaderStore };
});

const mockConfig = {
  booknotes: [] as unknown[],
};
const mockSaveConfig = vi.fn().mockResolvedValue(undefined);
const mockUpdateBooknotes = vi.fn((_bookKey: string, booknotes: unknown[]) => ({
  ...mockConfig,
  booknotes,
}));

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => mockBookData,
    getConfig: () => mockConfig,
    saveConfig: mockSaveConfig,
    updateBooknotes: mockUpdateBooknotes,
  }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      globalReadSettings: {
        highlightStyle: 'highlight',
        highlightStyles: { highlight: 'yellow' },
      },
    },
  }),
}));

vi.mock('@/store/proofreadStore', () => ({
  useProofreadStore: () => ({
    getMergedRules: () => [],
  }),
}));

vi.mock('@/services/transformers/proofread', () => ({
  proofreadTransformer: {
    transform: vi.fn(async (ctx: { content: string }) => ctx.content),
  },
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

// Track TTSController instantiations — this is the assertion target.
const ttsControllerInstances: unknown[] = [];
// Gate init() calls so that handleTTSSpeak stays suspended inside an `await`.
// This is the exact point where a second concurrent invocation would otherwise
// race ahead and construct a second TTSController. The test releases all
// pending resolvers once both dispatches have had a chance to interleave.
const pendingInitResolvers: Array<() => void> = [];
// Capture listeners the hook registers on the controller so tests can fire
// controller-emitted events (e.g. 'tts-highlight-mark') directly.
const controllerListeners: Record<string, ((e: Event) => void)[]> = {};
let initViewTTSError: Error | null = null;
// Test-mutable audiobook-active flag surfaced on the mock controller.
// Includes seekToText so the audiobook-seek handler can call it.
const mockAudiobookClient = {
  initialized: false,
  seekToText: vi.fn(async (_text: string) => true),
  cueToText: vi.fn(async (_text: string, _chapterIndex?: number) => true),
};

vi.mock('@/services/tts', () => ({
  TTSController: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {
      init: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            pendingInitResolvers.push(() => resolve());
          }),
      ),
      initViewTTS: vi.fn().mockImplementation(async () => {
        if (initViewTTSError) throw initViewTTSError;
      }),
      prepareSection: vi.fn().mockResolvedValue(true),
      updateHighlightOptions: vi.fn(),
      setLang: vi.fn(),
      setRate: vi.fn(),
      setVoice: vi.fn(),
      setTargetLang: vi.fn(),
      speak: vi.fn(),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forward: vi.fn().mockResolvedValue(undefined),
      backward: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      navigateToChapter: vi.fn().mockResolvedValue(undefined),
      getVoices: vi.fn().mockResolvedValue([]),
      getVoiceId: vi.fn().mockReturnValue(''),
      state: 'idle',
      sectionIndex: 0,
      ttsAudiobookClient: mockAudiobookClient,
      addEventListener: vi.fn((type: string, handler: (e: Event) => void) => {
        (controllerListeners[type] ||= []).push(handler);
      }),
      removeEventListener: vi.fn((type: string, handler: (e: Event) => void) => {
        const arr = controllerListeners[type];
        if (!arr) return;
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }),
      dispatchEvent: vi.fn(),
    });
    ttsControllerInstances.push(this);
  }),
}));

vi.mock('@/libs/mediaSession', () => ({
  TauriMediaSession: class {},
}));

vi.mock('@/utils/ssml', () => ({
  genSSMLRaw: vi.fn((s: string) => `<speak>${s}</speak>`),
  parseSSMLLang: vi.fn(() => 'en'),
}));

vi.mock('@/utils/throttle', () => ({
  throttle: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock('@/utils/cfi', () => ({
  isCfiInLocation: () => false,
}));

vi.mock('@/utils/misc', () => ({
  getLocale: () => 'en',
  uniqueId: vi.fn(() => 'new-note-id'),
}));

vi.mock('@/utils/ttsMetadata', () => ({
  buildTTSMediaMetadata: () => ({
    shouldUpdate: false,
    title: '',
    artist: '',
    album: '',
  }),
}));

vi.mock('@/utils/bridge', () => ({
  invokeUseBackgroundAudio: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/utils/ttsTime', () => ({
  estimateTTSTime: () => ({
    chapterRemainingSec: 0,
    bookRemainingSec: 0,
    finishAtTimestamp: 0,
  }),
}));

// A stable, test-controllable media-session ref. Defaults to current: null so
// existing tests behave exactly as before (the action-handler effect no-ops on
// a null session); the play/pause hardening test sets current to a fake
// Web-style MediaSession that records the handlers the hook registers.
const mediaSessionRefMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/app/reader/hooks/useTTSMediaSession', () => ({
  useTTSMediaSession: () => ({
    mediaSessionRef: mediaSessionRefMock,
    unblockAudio: vi.fn(),
    releaseUnblockAudio: vi.fn(),
    initMediaSession: vi.fn().mockResolvedValue(undefined),
    deinitMediaSession: vi.fn().mockResolvedValue(undefined),
  }),
}));

function makeFakeMediaSession() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    handlers,
    playbackState: 'none' as string,
    metadata: null as unknown,
    setActionHandler(action: string, fn: ((...args: unknown[]) => void) | null) {
      if (fn) handlers[action] = fn;
      else delete handlers[action];
    },
  };
}

// Imports must come AFTER vi.mock calls so they pick up the mocked modules.
import { useTTSControl } from '@/app/reader/hooks/useTTSControl';
import { eventDispatcher } from '@/utils/event';

let latestTTSControl: ReturnType<typeof useTTSControl> | null = null;

const Harness = () => {
  latestTTSControl = useTTSControl({ bookKey: 'book-1' });
  return null;
};

describe('useTTSControl concurrent tts-speak events', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
    for (const key of Object.keys(controllerListeners)) delete controllerListeners[key];
    initViewTTSError = null;
    mockProgress.sectionLabel = '';
    mockProgress.index = 0;
    document.body.innerHTML = '';
    mockAudiobookClient.initialized = false;
    mockView.resolveNavigation.mockClear();
    mockView.renderer.goTo.mockClear();
    mockView.renderer.scrollToAnchor.mockClear();
    mockView.addAnnotation.mockClear();
    mockView.resolveCFI.mockReturnValue({ index: 0, anchor: () => new Range() });
    mockView.getCFI.mockReturnValue('cfi');
    latestTTSControl = null;
  });

  afterEach(() => {
    cleanup();
  });

  it('creates only one TTSController when two tts-speak events fire back-to-back', async () => {
    render(<Harness />);

    await act(async () => {
      // Kick off both dispatches without awaiting — this models rapid clicks
      // where the second click arrives while the first is still inside its
      // initial awaits (initMediaSession / backgroundAudio / init()).
      const p1 = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
      const p2 = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });

      // Let both invocations drain microtasks and reach their gated await.
      // Without the single-flight guard in handleTTSSpeak, both invocations
      // would construct a TTSController here and both would be queued in
      // pendingInitResolvers.
      for (let i = 0; i < 10; i++) await Promise.resolve();

      // The assertion that matters: exactly one controller was constructed.
      expect(ttsControllerInstances.length).toBe(1);

      // Release any pending init() promises so the dispatch chain can unwind
      // cleanly (otherwise the act() would never settle).
      while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
      await Promise.all([p1, p2]);
    });
  });
});

describe('useTTSControl audio-as-leader behavior (audiobook)', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
    for (const key of Object.keys(controllerListeners)) delete controllerListeners[key];
    initViewTTSError = null;
    mockProgress.sectionLabel = '';
    mockProgress.index = 0;
    document.body.innerHTML = '';
    mockAudiobookClient.initialized = true;
    mockView.resolveNavigation.mockClear();
    mockView.renderer.goTo.mockClear();
    mockView.renderer.scrollToAnchor.mockClear();
    mockView.addAnnotation.mockClear();
    mockView.resolveCFI.mockReturnValue({ index: 0, anchor: () => new Range() });
    mockView.getCFI.mockReturnValue('cfi');
    mockConfig.booknotes = [];
    mockSaveConfig.mockClear();
    mockUpdateBooknotes.mockClear();
    latestTTSControl = null;
  });

  afterEach(() => {
    cleanup();
    mockAudiobookClient.initialized = false;
  });

  // Helper: spin up the controller via the real tts-speak path and wait for
  // the hook's listener-registration effect to attach handlers.
  const startAndAwait = async () => {
    const p = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
    await p;
    // Extra microtask flush so the post-setTtsController effect runs and
    // registers the controller event listeners.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('navigates the view to the audio section when highlight-mark fires for a different section', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    // Audio is on section 1; the view's primary rendered section is 0.
    mockView.resolveCFI.mockReturnValue({ index: 1, anchor: () => new Range() });

    const listeners = controllerListeners['tts-highlight-mark'] || [];
    expect(listeners.length).toBeGreaterThan(0);

    await act(async () => {
      for (const handler of listeners) {
        handler(new CustomEvent('tts-highlight-mark', { detail: { cfi: 'cfi-section-1' } }));
      }
    });

    // Audio is the leader → the hook must navigate the view to the audio's section.
    expect(mockView.resolveNavigation).toHaveBeenCalledWith(1);
    expect(mockView.renderer.goTo).toHaveBeenCalled();
  });

  it('does not overwrite the audiobook section hint with stale reader progress on speak marks', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    const controller = ttsControllerInstances[0] as {
      sectionIndex: number;
      sectionLabel: string;
    };
    controller.sectionIndex = 5;
    controller.sectionLabel = 'Audio section';
    mockProgress.index = 0;
    mockProgress.sectionLabel = 'Stale visible section';

    const listeners = controllerListeners['tts-speak-mark'] || [];
    expect(listeners.length).toBeGreaterThan(0);

    await act(async () => {
      for (const handler of listeners) {
        handler(
          new CustomEvent('tts-speak-mark', { detail: { name: '1', text: 'Current audio' } }),
        );
      }
    });

    expect(controller.sectionIndex).toBe(5);
    expect(controller.sectionLabel).toBe('Audio section');
  });

  it('keeps audiobook startup alive when deriving the initial CFI throws', async () => {
    render(<Harness />);
    mockView.getCFI.mockImplementationOnce(() => {
      throw new Error('bad range');
    });

    await act(async () => {
      await startAndAwait();
    });

    const controller = ttsControllerInstances[0] as {
      speak: ReturnType<typeof vi.fn>;
    };
    expect(controller.speak).toHaveBeenCalled();
  });

  it('falls back to raw text startup when view TTS init fails in audiobook mode', async () => {
    render(<Harness />);
    initViewTTSError = new Error('tts init exploded');
    mockProgress.sectionLabel = 'One';
    document.body.innerHTML = '<p>Fallback page text for audiobook startup.</p>';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await act(async () => {
      await startAndAwait();
    });

    const controller = ttsControllerInstances[0] as {
      speak: ReturnType<typeof vi.fn>;
    };
    expect(controller.speak).toHaveBeenCalledWith(
      '<speak>Fallback page text for audiobook startup.</speak>',
      false,
      expect.any(Function),
    );
    warnSpy.mockRestore();
  });

  // The flashlight button: the user listens at 2x and taps it after a passage
  // catches their ear — by then the narrator is already into the NEXT
  // paragraph. The button must highlight the paragraph BEFORE the one the
  // narrator is currently in.
  it('flashlight highlights the paragraph before the one being narrated', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    document.body.innerHTML =
      '<p id="para-1">First paragraph read moments ago.</p>' +
      '<p id="para-2">Second paragraph currently being narrated.</p>';
    // The latest highlight-mark cfi resolves to a position inside para-2.
    mockView.resolveCFI.mockReturnValue({
      index: 0,
      anchor: (doc: Document) => {
        const range = doc.createRange();
        range.selectNodeContents(doc.getElementById('para-2')!);
        return range;
      },
    });
    // Reset first: an earlier test can leave an unconsumed mockImplementationOnce
    // (a throwing getCFI) queued on this shared mock.
    mockView.getCFI.mockReset();
    mockView.getCFI.mockReturnValue('cfi-prev-paragraph');

    const timeListeners = controllerListeners['tts-audiobook-time'] || [];
    const speakListeners = controllerListeners['tts-speak-mark'] || [];
    const highlightListeners = controllerListeners['tts-highlight-mark'] || [];

    await act(async () => {
      for (const handler of timeListeners) {
        handler(
          new CustomEvent('tts-audiobook-time', {
            detail: { currentTime: 100, duration: 300, chapterTitle: 'Chapter', narratorName: 'N' },
          }),
        );
      }
      for (const handler of speakListeners) {
        handler(
          new CustomEvent('tts-speak-mark', {
            detail: { name: '1', text: 'Second paragraph currently being narrated.' },
          }),
        );
      }
      for (const handler of highlightListeners) {
        handler(new CustomEvent('tts-highlight-mark', { detail: { cfi: 'cfi-current' } }));
      }

      await latestTTSControl?.handleHighlightRecentAudiobook(10);
    });

    expect(mockView.addAnnotation).toHaveBeenCalledTimes(1);
    expect(mockUpdateBooknotes).toHaveBeenCalledWith(
      'book-1',
      expect.arrayContaining([
        expect.objectContaining({
          cfi: 'cfi-prev-paragraph',
          text: 'First paragraph read moments ago.',
          color: 'yellow',
        }),
      ]),
    );
    expect(mockSaveConfig).toHaveBeenCalled();
  });

  it('falls back to recent sentence marks when no paragraph can be resolved', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    const timeListeners = controllerListeners['tts-audiobook-time'] || [];
    const speakListeners = controllerListeners['tts-speak-mark'] || [];
    const highlightListeners = controllerListeners['tts-highlight-mark'] || [];
    expect(timeListeners.length).toBeGreaterThan(0);
    expect(speakListeners.length).toBeGreaterThan(0);
    expect(highlightListeners.length).toBeGreaterThan(0);

    await act(async () => {
      for (const handler of timeListeners) {
        handler(
          new CustomEvent('tts-audiobook-time', {
            detail: { currentTime: 100, duration: 300, chapterTitle: 'Chapter', narratorName: 'N' },
          }),
        );
      }
      for (const handler of speakListeners) {
        handler(new CustomEvent('tts-speak-mark', { detail: { name: '1', text: 'First keeper' } }));
      }
      for (const handler of highlightListeners) {
        handler(new CustomEvent('tts-highlight-mark', { detail: { cfi: 'cfi-1' } }));
      }

      for (const handler of timeListeners) {
        handler(
          new CustomEvent('tts-audiobook-time', {
            detail: { currentTime: 106, duration: 300, chapterTitle: 'Chapter', narratorName: 'N' },
          }),
        );
      }
      for (const handler of speakListeners) {
        handler(
          new CustomEvent('tts-speak-mark', { detail: { name: '2', text: 'Second keeper' } }),
        );
      }
      for (const handler of highlightListeners) {
        handler(new CustomEvent('tts-highlight-mark', { detail: { cfi: 'cfi-2' } }));
      }

      await latestTTSControl?.handleHighlightRecentAudiobook(10);
    });

    expect(mockView.addAnnotation).toHaveBeenCalledTimes(2);
    expect(mockUpdateBooknotes).toHaveBeenCalledWith(
      'book-1',
      expect.arrayContaining([
        expect.objectContaining({ cfi: 'cfi-1', text: 'First keeper', color: 'yellow' }),
        expect.objectContaining({ cfi: 'cfi-2', text: 'Second keeper', color: 'yellow' }),
      ]),
    );
    expect(mockSaveConfig).toHaveBeenCalled();
  });
});

describe('useTTSControl tts-audiobook-seek cross-chapter behavior', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
    for (const key of Object.keys(controllerListeners)) delete controllerListeners[key];
    initViewTTSError = null;
    mockProgress.sectionLabel = '';
    mockProgress.index = 0;
    document.body.innerHTML = '';
    mockAudiobookClient.initialized = true;
    mockAudiobookClient.seekToText.mockClear();
    mockAudiobookClient.seekToText.mockResolvedValue(true);
    mockAudiobookClient.cueToText.mockClear();
    mockAudiobookClient.cueToText.mockResolvedValue(true);
    mockView.resolveNavigation.mockClear();
    mockView.renderer.goTo.mockClear();
    mockView.addAnnotation.mockClear();
    mockView.resolveCFI.mockReturnValue({ index: 0, anchor: () => new Range() });
    mockView.getCFI.mockReturnValue('cfi');
    latestTTSControl = null;
  });

  afterEach(() => {
    cleanup();
    mockAudiobookClient.initialized = false;
  });

  const startAndAwait = async () => {
    const p = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
    await p;
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('cues the tapped section and auto-resumes on cross-chapter long-press while playing', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    const controller = ttsControllerInstances[0] as {
      state: string;
      sectionIndex: number;
      pause: ReturnType<typeof vi.fn>;
      prepareSection: ReturnType<typeof vi.fn>;
      navigateToChapter: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
    };
    controller.sectionIndex = 0;
    controller.state = 'playing';

    await act(async () => {
      await eventDispatcher.dispatch('tts-audiobook-seek', {
        bookKey: 'book-1',
        seekText: 'the cathedral stood silent',
        sectionIndex: 2,
      });
    });

    expect(controller.pause).toHaveBeenCalled();
    expect(controller.prepareSection).toHaveBeenCalledWith(2);
    expect(mockAudiobookClient.cueToText).toHaveBeenCalledWith('the cathedral stood silent');
    expect(controller.navigateToChapter).not.toHaveBeenCalled();
    // The user was listening — the narrator follows the finger and keeps going.
    expect(controller.start).toHaveBeenCalledTimes(1);
  });

  it('cues and auto-resumes on same-chapter long-press while playing', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    const controller = ttsControllerInstances[0] as {
      state: string;
      sectionIndex: number;
      pause: ReturnType<typeof vi.fn>;
      prepareSection: ReturnType<typeof vi.fn>;
      navigateToChapter: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
    };
    controller.sectionIndex = 2;
    controller.state = 'playing';

    await act(async () => {
      await eventDispatcher.dispatch('tts-audiobook-seek', {
        bookKey: 'book-1',
        seekText: 'the cathedral stood silent',
        sectionIndex: 2,
      });
    });

    expect(controller.pause).toHaveBeenCalled();
    expect(controller.prepareSection).toHaveBeenCalledWith(2);
    expect(controller.navigateToChapter).not.toHaveBeenCalled();
    expect(mockAudiobookClient.cueToText).toHaveBeenCalledWith('the cathedral stood silent');
    expect(controller.start).toHaveBeenCalledTimes(1);
  });

  it('does not auto-resume when the cue fails to find a target', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    const controller = ttsControllerInstances[0] as {
      state: string;
      sectionIndex: number;
      navigateToChapter: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      prepareSection: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
    };
    controller.sectionIndex = 2;
    controller.state = 'playing';
    controller.stop.mockClear();
    controller.pause.mockClear();
    controller.prepareSection.mockClear();
    controller.start.mockClear();
    mockAudiobookClient.cueToText.mockResolvedValueOnce(false);

    await act(async () => {
      await eventDispatcher.dispatch('tts-audiobook-seek', {
        bookKey: 'book-1',
        seekText: 'the cathedral stood silent',
        sectionIndex: 2,
      });
    });

    expect(controller.stop).not.toHaveBeenCalled();
    expect(controller.pause).toHaveBeenCalled();
    expect(controller.prepareSection).toHaveBeenCalledWith(2);
    expect(mockAudiobookClient.cueToText).toHaveBeenCalledWith('the cathedral stood silent');
    // Nothing was cued — restarting would replay the old spot at random.
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('does NOT call controller.start() on cue when user is already paused', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    const controller = ttsControllerInstances[0] as {
      state: string;
      sectionIndex: number;
      navigateToChapter: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      prepareSection: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
    };
    controller.sectionIndex = 2;
    controller.state = 'paused';
    controller.stop.mockClear();
    controller.pause.mockClear();
    controller.prepareSection.mockClear();
    controller.start.mockClear();

    await act(async () => {
      await eventDispatcher.dispatch('tts-audiobook-seek', {
        bookKey: 'book-1',
        seekText: 'the cathedral stood silent',
        sectionIndex: 2,
      });
    });

    expect(controller.pause).toHaveBeenCalled();
    expect(controller.prepareSection).toHaveBeenCalledWith(2);
    expect(mockAudiobookClient.cueToText).toHaveBeenCalledWith('the cathedral stood silent');
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('keeps cross-chapter long-press paused too', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    const controller = ttsControllerInstances[0] as {
      state: string;
      sectionIndex: number;
      pause: ReturnType<typeof vi.fn>;
      prepareSection: ReturnType<typeof vi.fn>;
      navigateToChapter: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
    };
    controller.sectionIndex = 0;
    controller.state = 'paused';
    controller.pause.mockClear();
    controller.prepareSection.mockClear();
    controller.navigateToChapter.mockClear();
    controller.start.mockClear();

    await act(async () => {
      await eventDispatcher.dispatch('tts-audiobook-seek', {
        bookKey: 'book-1',
        seekText: 'the cathedral stood silent',
        sectionIndex: 2,
      });
    });

    expect(controller.pause).toHaveBeenCalled();
    expect(controller.prepareSection).toHaveBeenCalledWith(2);
    expect(mockAudiobookClient.cueToText).toHaveBeenCalledWith('the cathedral stood silent');
    expect(controller.navigateToChapter).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });
});

describe('useTTSControl media-session play/pause hardening', () => {
  beforeEach(() => {
    ttsControllerInstances.length = 0;
    pendingInitResolvers.length = 0;
    for (const key of Object.keys(controllerListeners)) delete controllerListeners[key];
    initViewTTSError = null;
    mockProgress.sectionLabel = '';
    document.body.innerHTML = '';
    mockAudiobookClient.initialized = true;
    mediaSessionRefMock.current = makeFakeMediaSession();
  });

  afterEach(() => {
    cleanup();
    mockAudiobookClient.initialized = false;
    mediaSessionRefMock.current = null;
  });

  const startAndAwait = async () => {
    const p = eventDispatcher.dispatch('tts-speak', { bookKey: 'book-1' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    while (pendingInitResolvers.length > 0) pendingInitResolvers.shift()!();
    await p;
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  // A rapid double "play" — what happens when iOS delivers the lock-screen
  // play action while it is also natively resuming the <audio> element — must
  // only ever start ONE playback. Two starts here is the doubled-voice bug.
  it('starts playback only once when the play action fires twice in a row', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    const fake = mediaSessionRefMock.current as ReturnType<typeof makeFakeMediaSession>;
    const controller = ttsControllerInstances[0] as {
      state: string;
      start: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    controller.state = 'idle';

    // Move to a paused state via the lock-screen pause action.
    await act(async () => {
      fake.handlers['pause']?.();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    controller.start.mockClear();
    controller.resume.mockClear();

    // Fire play twice synchronously (native resume + action handler race).
    await act(async () => {
      fake.handlers['play']?.();
      fake.handlers['play']?.();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(controller.start.mock.calls.length + controller.resume.mock.calls.length).toBe(1);
  });

  it('routes the lock-screen pause action to a pause, never a resume', async () => {
    render(<Harness />);
    await act(async () => {
      await startAndAwait();
    });

    const fake = mediaSessionRefMock.current as ReturnType<typeof makeFakeMediaSession>;
    const controller = ttsControllerInstances[0] as {
      state: string;
      start: ReturnType<typeof vi.fn>;
      resume: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    controller.pause.mockClear();
    controller.start.mockClear();
    controller.resume.mockClear();

    await act(async () => {
      fake.handlers['pause']?.();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(controller.pause).toHaveBeenCalledTimes(1);
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.resume).not.toHaveBeenCalled();
  });
});
