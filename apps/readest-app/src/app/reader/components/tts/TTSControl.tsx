import clsx from 'clsx';
import React, { useState, useRef, useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useThemeStore } from '@/store/themeStore';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { useTTSControl } from '@/app/reader/hooks/useTTSControl';
import { eventDispatcher } from '@/utils/event';
import { getPopupPosition, Position } from '@/utils/sel';
import { Insets } from '@/types/misc';
import { Overlay } from '@/components/Overlay';
import Popup from '@/components/Popup';
import TTSPanel from './TTSPanel';
import TTSIcon from './TTSIcon';
import TTSBar from './TTSBar';

const POPUP_WIDTH = 282;
const POPUP_HEIGHT_DEFAULT = 160;
const POPUP_HEIGHT_AUDIOBOOK = 320;
const POPUP_PADDING = 10;

interface TTSControlProps {
  bookKey: string;
  gridInsets: Insets;
}

const TTSControl: React.FC<TTSControlProps> = ({ bookKey, gridInsets }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { safeAreaInsets } = useThemeStore();
  const { hoveredBookKey, getViewSettings } = useReaderStore();

  const viewSettings = getViewSettings(bookKey);

  const [showPanel, setShowPanel] = useState(false);
  const [panelPosition, setPanelPosition] = useState<Position>();
  const [trianglePosition, setTrianglePosition] = useState<Position>();

  const iconRef = useRef<HTMLDivElement>(null);
  const backButtonTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [shouldMountBackButton, setShouldMountBackButton] = useState(false);
  const [isBackButtonVisible, setIsBackButtonVisible] = useState(false);

  const popupPadding = useResponsiveSize(POPUP_PADDING);
  const maxWidth = window.innerWidth - 2 * popupPadding;
  const popupWidth = Math.min(maxWidth, useResponsiveSize(POPUP_WIDTH));
  const popupHeightDefault = useResponsiveSize(POPUP_HEIGHT_DEFAULT);
  const popupHeightAudiobook = useResponsiveSize(POPUP_HEIGHT_AUDIOBOOK);

  const tts = useTTSControl({
    bookKey,
    onRequestHidePanel: () => setShowPanel(false),
  });

  const popupHeight = tts.isAudiobookActive ? popupHeightAudiobook : popupHeightDefault;

  useEffect(() => {
    if (tts.showBackToCurrentTTSLocation) {
      setShouldMountBackButton(true);
      const fadeInTimeout = setTimeout(() => {
        setIsBackButtonVisible(true);
      }, 10);
      return () => clearTimeout(fadeInTimeout);
    } else {
      setIsBackButtonVisible(false);
      if (backButtonTimeoutRef.current) {
        clearTimeout(backButtonTimeoutRef.current);
      }
      backButtonTimeoutRef.current = setTimeout(() => {
        setShouldMountBackButton(false);
      }, 300);
      return;
    }
  }, [tts.showBackToCurrentTTSLocation]);

  useEffect(() => {
    if (!iconRef.current || !showPanel) return;
    const parentElement = iconRef.current.parentElement;
    if (!parentElement) return;

    const resizeObserver = new ResizeObserver(() => {
      updatePanelPosition();
    });
    resizeObserver.observe(parentElement);
    return () => {
      resizeObserver.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPanel]);

  useEffect(() => {
    if (tts.showTTSBar) {
      setShowPanel(false);
    }
  }, [tts.showTTSBar]);

  const updatePanelPosition = () => {
    if (iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      const parentRect =
        iconRef.current.parentElement?.getBoundingClientRect() ||
        document.documentElement.getBoundingClientRect();

      const trianglePos = {
        dir: 'up',
        point: { x: rect.left + rect.width / 2 - parentRect.left, y: rect.top - 12 },
      } as Position;

      const popupPos = getPopupPosition(
        trianglePos,
        parentRect,
        popupWidth,
        popupHeight,
        popupPadding,
      );

      setPanelPosition(popupPos);
      setTrianglePosition(trianglePos);
    }
  };

  const togglePopup = () => {
    // If TTS hasn't been started yet, the button acts as a "start" button:
    // fire tts-speak and let the controller initialize. The popup has nothing
    // to show pre-init, so we don't toggle it on this first tap. Once the
    // controller is ready, subsequent taps toggle the panel as usual.
    if (!tts.isTTSActive) {
      eventDispatcher.dispatch('tts-speak', { bookKey });
      return;
    }
    updatePanelPosition();
    if (!showPanel) {
      tts.refreshTtsLang();
    }
    setShowPanel((prev) => !prev);
  };

  const handleDismissPopup = () => {
    setShowPanel(false);
  };

  return (
    <>
      {shouldMountBackButton && (
        <div
          className={clsx(
            'absolute left-1/2 top-0 z-50 -translate-x-1/2',
            'transition-opacity duration-300',
            isBackButtonVisible ? 'opacity-100' : 'opacity-0',
            safeAreaInsets?.top ? '' : 'py-1',
          )}
          style={{
            top: `${safeAreaInsets?.top || 0}px`,
          }}
        >
          <button
            onClick={tts.handleBackToCurrentTTSLocation}
            className={clsx(
              'not-eink:bg-base-300 eink-bordered rounded-full px-4 py-2 font-sans text-sm shadow-lg',
              safeAreaInsets?.top ? 'h-11' : 'h-9',
            )}
          >
            {_('Back to TTS Location')}
          </button>
        </div>
      )}
      {showPanel && <Overlay onDismiss={handleDismissPopup} />}
      {/*
       * Persistent floating TTS / audiobook trigger. Always rendered — no
       * hover gating, no init gating, no auto-hide — so users can start or
       * re-open the audio panel at any time. Before TTS has been started,
       * the button dispatches a tts-speak event on tap (see togglePopup).
       * `ttsInited` is passed as `true` so the icon always looks clickable;
       * the underlying initialization state is handled by the click handler.
       */}
      <div
        ref={iconRef}
        className={clsx(
          'absolute z-40 h-12 w-12',
          'transition-transform duration-300',
          viewSettings?.rtl ? 'left-8' : 'right-6',
          !appService?.hasSafeAreaInset && 'bottom-[70px] sm:bottom-14',
        )}
        style={{
          bottom: appService?.hasSafeAreaInset
            ? `calc(env(safe-area-inset-bottom, 0px) * ${appService?.isIOSApp ? 0.33 : 1} + ${hoveredBookKey ? 70 : 52}px)`
            : undefined,
        }}
      >
        <TTSIcon isPlaying={tts.isPlaying} ttsInited onClick={togglePopup} />
      </div>
      {showPanel && panelPosition && trianglePosition && tts.ttsClientsInited && (
        <Popup
          width={popupWidth}
          height={popupHeight}
          position={panelPosition}
          trianglePosition={trianglePosition}
          className='bg-base-200 flex shadow-lg'
          onDismiss={handleDismissPopup}
        >
          <TTSPanel
            bookKey={bookKey}
            ttsLang={tts.ttsLang}
            isPlaying={tts.isPlaying}
            isAudiobookActive={tts.isAudiobookActive}
            timeoutOption={tts.timeoutOption}
            timeoutTimestamp={tts.timeoutTimestamp}
            audiobookCurrentTime={tts.audiobookCurrentTime}
            audiobookDuration={tts.audiobookDuration}
            audiobookChapterTitle={tts.audiobookChapterTitle}
            audiobookNarrator={tts.audiobookNarrator}
            onTogglePlay={tts.handleTogglePlay}
            onBackward={tts.handleBackward}
            onForward={tts.handleForward}
            onSetRate={tts.handleSetRate}
            onGetVoices={tts.handleGetVoices}
            onSetVoice={tts.handleSetVoice}
            onGetVoiceId={tts.handleGetVoiceId}
            onSelectTimeout={tts.handleSelectTimeout}
            onToogleTTSBar={tts.handleToggleTTSBar}
            onGetChapters={tts.handleGetChapters}
            onJumpToChapter={tts.handleJumpToChapter}
            onScrub={tts.handleSeekTo}
          />
        </Popup>
      )}
      {/*
       * TTSBar auto-shows during audiobook playback even if the user hasn't
       * explicitly toggled `showTTSBar`, because the bar has the transport
       * controls (skip ±15/30s, play/pause, backward/forward) that are most
       * useful for audiobook listening. For non-audiobook TTS we keep the
       * original opt-in behavior so the bar doesn't appear unprompted.
       */}
      {tts.showIndicator && (tts.showTTSBar || tts.isAudiobookActive) && tts.ttsClientsInited && (
        <TTSBar
          bookKey={bookKey}
          isPlaying={tts.isPlaying}
          isAudiobookActive={tts.isAudiobookActive}
          onBackward={tts.handleBackward}
          onTogglePlay={tts.handleTogglePlay}
          onForward={tts.handleForward}
          onSkipBack={tts.handleSkipBack}
          onSkipForward={tts.handleSkipForward}
          gridInsets={gridInsets}
        />
      )}
    </>
  );
};

export default TTSControl;
