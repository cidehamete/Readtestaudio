import clsx from 'clsx';
import { useState, ChangeEvent, useEffect, useRef } from 'react';
import {
  MdPlayCircle,
  MdPauseCircle,
  MdFastRewind,
  MdFastForward,
  MdAlarm,
  MdHeadphones,
  MdQueueMusic,
  MdLinkOff,
  MdLink,
} from 'react-icons/md';
import { TbChevronCompactDown, TbChevronCompactUp } from 'react-icons/tb';
import { RiVoiceAiFill } from 'react-icons/ri';
import { MdCheck } from 'react-icons/md';
import { TTSVoicesGroup } from '@/services/tts';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { TranslationFunc, useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useDefaultIconSize, useResponsiveSize } from '@/hooks/useResponsiveSize';
import { getLanguageName } from '@/utils/lang';
import {
  extractManifestUrl,
  getAudiobookManifestUrl,
  setAudiobookManifestUrl,
  removeAudiobookManifestUrl,
} from '@/hooks/useAudiobookLink';
import { eventDispatcher } from '@/utils/event';

type TTSPanelProps = {
  bookKey: string;
  ttsLang: string;
  isPlaying: boolean;
  isAudiobookActive?: boolean;
  timeoutOption: number;
  timeoutTimestamp: number;
  audiobookCurrentTime?: number;
  audiobookDuration?: number;
  audiobookChapterTitle?: string;
  audiobookNarrator?: string;
  onTogglePlay: () => void;
  onBackward: () => void;
  onForward: () => void;
  onSetRate: (rate: number) => void;
  onGetVoices: (lang: string) => Promise<TTSVoicesGroup[]>;
  onSetVoice: (voice: string, lang: string) => void;
  onGetVoiceId: () => string;
  onSelectTimeout: (bookKey: string, value: number) => void;
  onToogleTTSBar: () => void;
  onGetChapters: () => { index: number; title: string; duration_seconds: number }[];
  onJumpToChapter: (chapterIndex: number) => void;
  onScrub: (seconds: number) => void;
};

const getTTSTimeoutOptions = (_: TranslationFunc) => {
  return [
    { label: _('No Timeout'), value: 0 },
    { label: _('{{value}} minute', { value: 1 }), value: 60 },
    { label: _('{{value}} minutes', { value: 3 }), value: 180 },
    { label: _('{{value}} minutes', { value: 5 }), value: 300 },
    { label: _('{{value}} minutes', { value: 10 }), value: 600 },
    { label: _('{{value}} minutes', { value: 20 }), value: 1200 },
    { label: _('{{value}} minutes', { value: 30 }), value: 1800 },
    { label: _('{{value}} minutes', { value: 45 }), value: 2700 },
    { label: _('{{value}} hour', { value: 1 }), value: 3600 },
    { label: _('{{value}} hours', { value: 2 }), value: 7200 },
    { label: _('{{value}} hours', { value: 3 }), value: 10800 },
    { label: _('{{value}} hours', { value: 4 }), value: 14400 },
    { label: _('{{value}} hours', { value: 6 }), value: 21600 },
    { label: _('{{value}} hours', { value: 8 }), value: 28800 },
  ];
};

const getCountdownTime = (timeout: number) => {
  const now = Date.now();
  if (timeout > now) {
    const remainingTime = Math.floor((timeout - now) / 1000);
    const minutes = Math.floor(remainingTime / 3600) * 60 + Math.floor((remainingTime % 3600) / 60);
    const seconds = remainingTime % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  }
  return '';
};

const formatTime = (seconds: number): string => {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const TTSPanel = ({
  bookKey,
  ttsLang,
  isPlaying,
  isAudiobookActive = false,
  timeoutOption,
  timeoutTimestamp,
  audiobookCurrentTime = 0,
  audiobookDuration = 0,
  audiobookChapterTitle = '',
  audiobookNarrator = '',
  onTogglePlay,
  onBackward,
  onForward,
  onSetRate,
  onGetVoices,
  onSetVoice,
  onGetVoiceId,
  onSelectTimeout,
  onToogleTTSBar,
  onGetChapters,
  onJumpToChapter,
  onScrub,
}: TTSPanelProps) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { getViewSettings, setViewSettings } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const viewSettings = getViewSettings(bookKey);
  const bookHash = getBookData(bookKey)?.book?.hash ?? '';

  const [voiceGroups, setVoiceGroups] = useState<TTSVoicesGroup[]>([]);
  const [rate, setRate] = useState(viewSettings?.ttsRate ?? 1.0);
  const [selectedVoice, setSelectedVoice] = useState(viewSettings?.ttsVoice ?? '');
  const [timeoutCountdown, setTimeoutCountdown] = useState(() =>
    getCountdownTime(timeoutTimestamp),
  );
  const [linkedManifestUrl, setLinkedManifestUrl] = useState<string | null>(() =>
    bookHash ? getAudiobookManifestUrl(bookHash) : null,
  );
  const [manifestInput, setManifestInput] = useState('');
  const [showLinkInput, setShowLinkInput] = useState(false);
  const manifestInputRef = useRef<HTMLInputElement>(null);

  const defaultIconSize = useDefaultIconSize();
  const iconSize32 = useResponsiveSize(32);
  const iconSize48 = useResponsiveSize(48);

  const SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

  const handleSetRate = (e: ChangeEvent<HTMLInputElement>) => {
    let newRate = parseFloat(e.target.value);
    newRate = Math.max(0.2, Math.min(3.0, newRate));
    setRate(newRate);
    onSetRate(newRate);
    const vs = getViewSettings(bookKey)!;
    vs.ttsRate = newRate;
    settings.globalViewSettings.ttsRate = newRate;
    setViewSettings(bookKey, vs);
    setSettings(settings);
    saveSettings(envConfig, settings);
  };

  const handleSetRatePreset = (preset: number) => {
    setRate(preset);
    onSetRate(preset);
    const vs = getViewSettings(bookKey)!;
    vs.ttsRate = preset;
    settings.globalViewSettings.ttsRate = preset;
    setViewSettings(bookKey, vs);
    setSettings(settings);
    saveSettings(envConfig, settings);
  };

  const handleSelectVoice = (voice: string, lang: string) => {
    onSetVoice(voice, lang);
    setSelectedVoice(voice);
    const vs = getViewSettings(bookKey)!;
    vs.ttsVoice = voice;
    setViewSettings(bookKey, vs);
  };

  const updateTimeout = (timeout: number) => {
    const now = Date.now();
    if (timeout > 0 && timeout < now) {
      onSelectTimeout(bookKey, 0);
      setTimeoutCountdown('');
    } else if (timeout > 0) {
      setTimeoutCountdown(getCountdownTime(timeout));
    }
  };

  useEffect(() => {
    setTimeout(() => {
      updateTimeout(timeoutTimestamp);
    }, 1000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeoutTimestamp, timeoutCountdown]);

  useEffect(() => {
    const voiceId = onGetVoiceId();
    setSelectedVoice(voiceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const fetchVoices = async () => {
      const voiceGroups = await onGetVoices(ttsLang);
      const voicesCount = voiceGroups.reduce((acc, group) => acc + group.voices.length, 0);
      if (!voiceGroups || voicesCount === 0) {
        console.warn('No voices found for TTSPanel');
        setVoiceGroups([
          {
            id: 'no-voices',
            name: _('Voices for {{lang}}', { lang: getLanguageName(ttsLang) }),
            voices: [],
          },
        ]);
      } else {
        setVoiceGroups(voiceGroups);
      }
    };
    fetchVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsLang]);

  useEffect(() => {
    if (showLinkInput) {
      manifestInputRef.current?.focus();
    }
  }, [showLinkInput]);

  const handleLinkAudiobook = () => {
    const url = extractManifestUrl(manifestInput);
    if (!url) {
      eventDispatcher.dispatch('toast', {
        message: _('Invalid audiobook URL. Paste the manifest URL or the player URL.'),
        type: 'error',
        timeout: 4000,
      });
      return;
    }
    setAudiobookManifestUrl(bookHash, url);
    setLinkedManifestUrl(url);
    setManifestInput('');
    setShowLinkInput(false);
    eventDispatcher.dispatch('toast', {
      message: _('Audiobook linked. Restart TTS to use it.'),
      type: 'success',
      timeout: 4000,
    });
    // Stop active TTS so the user restarts with the new manifest
    eventDispatcher.dispatch('tts-stop', { bookKey });
  };

  const handleUnlinkAudiobook = () => {
    removeAudiobookManifestUrl(bookHash);
    setLinkedManifestUrl(null);
    eventDispatcher.dispatch('toast', {
      message: _('Audiobook unlinked.'),
      type: 'success',
      timeout: 3000,
    });
    eventDispatcher.dispatch('tts-stop', { bookKey });
  };

  const timeoutOptions = getTTSTimeoutOptions(_);
  const chapters = isAudiobookActive ? onGetChapters() : [];
  const timeRemaining = audiobookDuration > 0 ? audiobookDuration - audiobookCurrentTime : 0;

  return (
    <div className='flex w-full flex-col items-center justify-center gap-2 rounded-2xl px-4 pt-4 sm:gap-1'>
      {/* ── Audiobook badge ─────────────────────────────────────── */}
      {isAudiobookActive && (
        <div className='flex w-full flex-col items-center gap-0.5 pb-1'>
          <div className='text-primary flex items-center gap-1 text-xs'>
            <MdHeadphones size={14} />
            {audiobookNarrator ? (
              <span className='font-medium'>{audiobookNarrator}</span>
            ) : (
              <span>{_('Audiobook')}</span>
            )}
          </div>
          {audiobookChapterTitle && (
            <span className='max-w-full truncate text-center text-xs opacity-60'>
              {audiobookChapterTitle}
            </span>
          )}
          {timeRemaining > 0 && (
            <span className='text-xs opacity-50'>
              {formatTime(timeRemaining)} {_('remaining')}
            </span>
          )}
        </div>
      )}

      {/* ── Audiobook scrubber ───────────────────────────────────── */}
      {isAudiobookActive && audiobookDuration > 0 && (
        <div className='flex w-full flex-col gap-0.5 pb-1'>
          <input
            type='range'
            min={0}
            max={audiobookDuration}
            step={1}
            value={audiobookCurrentTime}
            onChange={(e) => onScrub(parseFloat(e.target.value))}
            className='range range-xs range-primary w-full'
          />
          <div className='flex w-full justify-between text-xs opacity-50'>
            <span>{formatTime(audiobookCurrentTime)}</span>
            <span>{formatTime(audiobookDuration)}</span>
          </div>
        </div>
      )}

      {/* ── Rate slider + presets ────────────────────────────────── */}
      <div className='flex w-full flex-col items-center gap-0.5'>
        <input
          className='range'
          type='range'
          min={0.0}
          max={3.0}
          step='0.1'
          value={rate}
          onChange={handleSetRate}
        />
        <div className='grid w-full grid-cols-7 text-xs'>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
          <span className='text-center'>|</span>
        </div>
        <div className='grid w-full grid-cols-7 text-xs'>
          <span className='text-center'>{_('Slow')}</span>
          <span className='text-center'></span>
          <span className='text-center'>1.0</span>
          <span className='text-center'>1.5</span>
          <span className='text-center'>2.0</span>
          <span className='text-center'></span>
          <span className='text-center'>{_('Fast')}</span>
        </div>
        <div className='mt-1 flex w-full justify-center gap-1'>
          {SPEED_PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => handleSetRatePreset(preset)}
              className={clsx(
                'rounded-full px-2 py-0.5 text-xs transition-colors duration-150',
                Math.abs(rate - preset) < 0.01
                  ? 'bg-primary text-primary-content'
                  : 'bg-base-300 hover:bg-base-content/20',
              )}
            >
              {preset === 1.0 ? '1×' : `${preset}×`}
            </button>
          ))}
        </div>
      </div>

      {/* ── Playback controls row ────────────────────────────────── */}
      <div className='flex items-center justify-between space-x-2'>
        <button
          onClick={() => onBackward()}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={_('Previous Paragraph')}
          aria-label={_('Previous Paragraph')}
        >
          <MdFastRewind size={iconSize32} />
        </button>
        <button
          onClick={onTogglePlay}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={isPlaying ? _('Pause') : _('Play')}
          aria-label={isPlaying ? _('Pause') : _('Play')}
        >
          {isPlaying ? (
            <MdPauseCircle size={iconSize48} className='fill-primary' />
          ) : (
            <MdPlayCircle size={iconSize48} className='fill-primary' />
          )}
        </button>
        <button
          onClick={() => onForward()}
          className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
          title={_('Next Paragraph')}
          aria-label={_('Next Paragraph')}
        >
          <MdFastForward size={iconSize32} />
        </button>

        {/* ── Chapter list dropdown (audiobook only) ────────────── */}
        {isAudiobookActive && chapters.length > 0 && (
          <div className='dropdown dropdown-top'>
            <button
              tabIndex={0}
              className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
              onClick={(e) => e.currentTarget.focus()}
              title={_('Chapter List')}
              aria-label={_('Chapter List')}
            >
              <MdQueueMusic size={iconSize32} />
            </button>
            <ul
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              className={clsx(
                'dropdown-content bgcolor-base-200 no-triangle menu menu-vertical rounded-box absolute right-0 z-[1] shadow',
                'mt-4 inline max-h-80 w-[240px] overflow-y-scroll',
              )}
            >
              {chapters.map((ch) => (
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
                <li key={ch.index} onClick={() => onJumpToChapter(ch.index)}>
                  <div className='flex items-center gap-2 px-2 py-1'>
                    <span style={{ width: `${defaultIconSize}px`, height: `${defaultIconSize}px` }}>
                      {ch.title === audiobookChapterTitle && <MdCheck className='text-primary' />}
                    </span>
                    <div className='flex min-w-0 flex-col'>
                      <span className='truncate text-sm sm:text-xs'>{ch.title}</span>
                      <span className='text-xs opacity-50'>{formatTime(ch.duration_seconds)}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Timeout dropdown ─────────────────────────────────────── */}
        <div className='dropdown dropdown-top'>
          <button
            tabIndex={0}
            className='flex flex-col items-center justify-center rounded-full p-1 transition-transform duration-200 hover:scale-105'
            onClick={(e) => e.currentTarget.focus()}
            title={_('Set Timeout')}
            aria-label={_('Set Timeout')}
          >
            <MdAlarm size={iconSize32} />
            {timeoutCountdown && (
              <span
                className={clsx(
                  'absolute bottom-0 left-1/2 w-12 translate-x-[-50%] translate-y-[80%] px-1',
                  'bg-primary/80 text-base-100 rounded-full text-center text-xs',
                )}
              >
                {timeoutCountdown}
              </span>
            )}
          </button>
          <ul
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            className={clsx(
              'dropdown-content bgcolor-base-200 no-triangle menu menu-vertical rounded-box absolute right-0 z-[1] shadow',
              'mt-4 inline max-h-96 w-[200px] overflow-y-scroll',
            )}
          >
            {timeoutOptions.map((option, index) => (
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
              <li
                key={`${index}-${option.value}`}
                onClick={() => onSelectTimeout(bookKey, option.value)}
              >
                <div className='flex items-center px-2'>
                  <span style={{ width: `${defaultIconSize}px`, height: `${defaultIconSize}px` }}>
                    {timeoutOption === option.value && <MdCheck className='text-base-content' />}
                  </span>
                  <span className={clsx('text-base sm:text-sm')}>{option.label}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* ── Voice dropdown (hidden in audiobook mode) ─────────── */}
        {!isAudiobookActive && (
          <div className='dropdown dropdown-top'>
            <button
              tabIndex={0}
              className='rounded-full p-1 transition-transform duration-200 hover:scale-105'
              onClick={(e) => e.currentTarget.focus()}
            >
              <RiVoiceAiFill size={iconSize32} />
            </button>
            <ul
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              className={clsx(
                'dropdown-content bgcolor-base-200 no-triangle menu menu-vertical rounded-box absolute right-0 z-[1] shadow',
                'mt-4 inline max-h-96 w-[250px] overflow-y-scroll',
              )}
              title={_('Select Voice')}
              aria-label={_('Select Voice')}
            >
              {voiceGroups.map((voiceGroup, index) => (
                <div key={voiceGroup.id}>
                  <div className='flex items-center gap-2 px-2 py-1'>
                    <span
                      style={{ width: `${defaultIconSize}px`, height: `${defaultIconSize}px` }}
                    ></span>
                    <span className='text-sm text-gray-400 sm:text-xs'>
                      {_('{{engine}}: {{count}} voices', {
                        engine: _(voiceGroup.name),
                        count: voiceGroup.voices.length,
                      })}
                    </span>
                  </div>
                  {voiceGroup.voices.map((voice, voiceIndex) => (
                    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
                    <li
                      key={`${index}-${voiceGroup.id}-${voiceIndex}`}
                      onClick={() => !voice.disabled && handleSelectVoice(voice.id, voice.lang)}
                    >
                      <div className='flex items-center px-2'>
                        <span
                          style={{
                            width: `${defaultIconSize}px`,
                            height: `${defaultIconSize}px`,
                          }}
                        >
                          {selectedVoice === voice.id && <MdCheck className='text-base-content' />}
                        </span>
                        <span
                          className={clsx(
                            'max-w-[180px] overflow-hidden text-ellipsis text-base sm:text-sm',
                            voice.disabled && 'text-gray-400',
                          )}
                        >
                          {_(voice.name)}
                        </span>
                      </div>
                    </li>
                  ))}
                </div>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── Manifest link/unlink UI ─────────────────────────────── */}
      {bookHash && (
        <div className='border-base-content/10 flex w-full flex-col items-center gap-1 border-t pt-2'>
          {linkedManifestUrl ? (
            <button
              onClick={handleUnlinkAudiobook}
              className='flex items-center gap-1 text-xs opacity-60 transition-opacity hover:opacity-100'
              title={_('Unlink Audiobook')}
            >
              <MdLinkOff size={14} />
              <span>{_('Unlink Audiobook')}</span>
            </button>
          ) : showLinkInput ? (
            <div className='flex w-full items-center gap-1'>
              <input
                ref={manifestInputRef}
                type='text'
                value={manifestInput}
                onChange={(e) => setManifestInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLinkAudiobook()}
                placeholder={_('Paste manifest or player URL')}
                className='input input-bordered input-xs flex-1 text-xs'
              />
              <button onClick={handleLinkAudiobook} className='btn btn-primary btn-xs'>
                {_('Link')}
              </button>
              <button onClick={() => setShowLinkInput(false)} className='btn btn-ghost btn-xs'>
                ✕
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowLinkInput(true)}
              className='flex items-center gap-1 text-xs opacity-60 transition-opacity hover:opacity-100'
            >
              <MdLink size={14} />
              <span>{_('Link Audiobook')}</span>
            </button>
          )}
        </div>
      )}

      {/* ── TTS bar toggle ──────────────────────────────────────── */}
      <div className='flex h-4 items-center justify-center opacity-60 transition-transform duration-200 hover:scale-105 hover:opacity-100'>
        <button
          onClick={onToogleTTSBar}
          className='p-0'
          title={_('Toggle Sticky Bottom TTS Bar')}
          aria-label={_('Toggle Sticky Bottom TTS Bar')}
        >
          {viewSettings?.showTTSBar ? (
            <TbChevronCompactUp size={iconSize48} style={{ transform: 'scaleY(0.85)' }} />
          ) : (
            <TbChevronCompactDown size={iconSize48} style={{ transform: 'scaleY(0.85)' }} />
          )}
        </button>
      </div>
    </div>
  );
};

export default TTSPanel;
