/**
 * AudiobookTTSClient — plays pre-recorded audiobooks from Cloudflare R2.
 *
 * Audiobooks are produced by the companion audiobook-maker tool, which outputs:
 *   {slug}/manifest.json
 *   {slug}/audio/chapter_NN.mp3        (64 kbps mono MP3)
 *   {slug}/timestamps/chapter_NN_timestamps.json  (word-level timing)
 *
 * This client implements the TTSClient interface so it slots directly into
 * Readest's TTSController without requiring changes to any UI components.
 */

import { TTSClient, TTSMessageEvent } from './TTSClient';
import { TTSGranularity, TTSVoice, TTSVoicesGroup } from './types';
import { TTSController } from './TTSController';
import { parseSSMLMarks } from '@/utils/ssml';

// Drift threshold: if audio position deviates more than this from expected, seek to correct.
const SEEK_DRIFT_THRESHOLD_SEC = 2.0;

// ─── Manifest types (matching audiobook-maker's generator.py output) ──────────

interface AudiobookWord {
  word: string;
  start: number; // seconds
  end: number; // seconds
}

interface AudiobookChapterTimestamps {
  chapter: number;
  title: string;
  duration_seconds: number;
  words: AudiobookWord[];
}

interface AudiobookChapter {
  index: number;
  title: string;
  audio_url: string;
  timestamps_url: string;
  word_count: number;
  duration_seconds: number;
}

interface AudiobookManifest {
  title: string;
  slug: string;
  voice_id: string;
  voice_name: string;
  generated_at: string;
  total_chapters: number;
  chapters: AudiobookChapter[];
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class AudiobookTTSClient implements TTSClient {
  name = 'audiobook';
  initialized = false;
  controller?: TTSController;

  #manifestUrl: string;
  #manifest: AudiobookManifest | null = null;
  #audioEl: HTMLAudioElement | null = null;
  #nextAudioEl: HTMLAudioElement | null = null;
  #primaryLang = 'en';
  #speakingLang = 'en';
  #currentChapterIndex = -1;
  #timestampsCache = new Map<string, AudiobookChapterTimestamps>();
  #playbackRate = 1.0;
  #positionSaveIntervalId: ReturnType<typeof setInterval> | null = null;
  #lastTimeDispatchMs = 0;

  constructor(controller: TTSController, manifestUrl: string) {
    this.controller = controller;
    this.#manifestUrl = manifestUrl;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async init(): Promise<boolean> {
    try {
      const res = await fetch(this.#manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.#manifest = (await res.json()) as AudiobookManifest;
      this.#audioEl = new Audio();
      this.#audioEl.preload = 'auto';
      this.#audioEl.playbackRate = this.#playbackRate;
      this.#audioEl.preservesPitch = true;
      (
        this.#audioEl as HTMLAudioElement & {
          mozPreservesPitch?: boolean;
          webkitPreservesPitch?: boolean;
        }
      ).mozPreservesPitch = true;
      (
        this.#audioEl as HTMLAudioElement & {
          mozPreservesPitch?: boolean;
          webkitPreservesPitch?: boolean;
        }
      ).webkitPreservesPitch = true;
      this.#audioEl.addEventListener('timeupdate', this.#handleTimeUpdate);
      // Save position every 10 seconds during playback
      this.#positionSaveIntervalId = setInterval(() => this.#savePosition(), 10_000);
      this.initialized = true;
      console.info(
        `[AudiobookTTSClient] Loaded "${this.#manifest.title}" (${this.#manifest.total_chapters} chapters)`,
      );
      return true;
    } catch (e) {
      console.warn('[AudiobookTTSClient] init failed:', e);
      this.#dispatchError("Audiobook manifest couldn't be loaded. Falling back to TTS.");
      return false;
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
    if (this.#positionSaveIntervalId !== null) {
      clearInterval(this.#positionSaveIntervalId);
      this.#positionSaveIntervalId = null;
    }
    this.#nextAudioEl?.pause();
    this.#nextAudioEl = null;
    this.#audioEl?.removeEventListener('timeupdate', this.#handleTimeUpdate);
    this.#audioEl = null;
    this.#manifest = null;
    this.#timestampsCache.clear();
    this.initialized = false;
  }

  // ── Chapter matching ─────────────────────────────────────────────────────────

  /** Strip chapter/part numbering and punctuation for fuzzy title comparison. */
  #normalizeForMatch(s: string): string {
    return s
      .toLowerCase()
      .replace(/\b(chapter|part|section)\b\s*[\divxlc]+\s*[:\.\-]?\s*/gi, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Find the manifest chapter matching the current EPUB section label.
   * Three tiers:
   *  1. Exact case-insensitive match.
   *  2. Normalized match (strip numbering, punctuation).
   *  3. Position-based fallback using the EPUB section index.
   */
  #findChapter(sectionLabel: string): AudiobookChapter | null {
    if (!this.#manifest || !sectionLabel) return null;
    const label = sectionLabel.trim().toLowerCase();

    // Tier 1: exact
    const exact = this.#manifest.chapters.find((c) => c.title.trim().toLowerCase() === label);
    if (exact) return exact;

    // Tier 2: normalized
    const normLabel = this.#normalizeForMatch(label);
    if (normLabel) {
      const normalized = this.#manifest.chapters.find(
        (c) => this.#normalizeForMatch(c.title) === normLabel,
      );
      if (normalized) return normalized;
    }

    // Tier 3: position fallback — use EPUB section index to pick the manifest chapter
    const sectionIndex = this.controller?.sectionIndex ?? -1;
    if (sectionIndex >= 0 && sectionIndex < this.#manifest.chapters.length) {
      return this.#manifest.chapters[sectionIndex] ?? null;
    }

    return null;
  }

  async #loadTimestamps(url: string): Promise<AudiobookChapterTimestamps | null> {
    if (this.#timestampsCache.has(url)) return this.#timestampsCache.get(url)!;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AudiobookChapterTimestamps;
      this.#timestampsCache.set(url, data);
      return data;
    } catch (e) {
      console.warn('[AudiobookTTSClient] Failed to load timestamps:', e);
      this.#dispatchError(`Timestamps missing for a chapter — playing without word highlights.`);
      return null;
    }
  }

  // ── Timestamp matching ───────────────────────────────────────────────────────

  /**
   * Map each SSML mark (sentence) to a start time in the word-timestamp array.
   *
   * Strategy: take the first 4 non-trivial words of each sentence, normalise
   * them, then do a forward-scanning substring search through the word list.
   * Falls back to proportional distribution if no match is found.
   */
  #buildSentenceStartTimes(words: AudiobookWord[], marks: { text: string }[]): number[] {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const wordNorms = words.map((w) => norm(w.word));
    const totalDuration = words[words.length - 1]?.end ?? 0;

    let searchStartIdx = 0;
    const startTimes: number[] = [];

    for (let mi = 0; mi < marks.length; mi++) {
      const mark = marks[mi]!;

      // Take the first 4 words that are longer than 1 character
      const keyWords = mark.text
        .trim()
        .split(/\s+/)
        .map((w) => norm(w))
        .filter((w) => w.length > 1)
        .slice(0, 4);

      if (keyWords.length === 0) {
        startTimes.push(words[searchStartIdx]?.start ?? 0);
        continue;
      }

      let found = false;
      const limit = words.length - keyWords.length;

      // Primary pass: try matching starting from current search position
      for (let i = searchStartIdx; i <= limit; i++) {
        let match = true;
        for (let j = 0; j < keyWords.length; j++) {
          if (!wordNorms[i + j]?.includes(keyWords[j]!)) {
            match = false;
            break;
          }
        }
        if (match) {
          startTimes.push(words[i]!.start);
          searchStartIdx = i + 1;
          found = true;
          break;
        }
      }

      if (!found) {
        // Try with a 1-word offset (handles occasional leading stray words)
        const shifted = keyWords.slice(1);
        if (shifted.length > 0) {
          for (let i = searchStartIdx; i <= limit; i++) {
            let match = true;
            for (let j = 0; j < shifted.length; j++) {
              if (!wordNorms[i + j]?.includes(shifted[j]!)) {
                match = false;
                break;
              }
            }
            if (match) {
              startTimes.push(words[i]!.start);
              searchStartIdx = i + 1;
              found = true;
              break;
            }
          }
        }
      }

      if (!found) {
        // Proportional fallback
        startTimes.push((mi / marks.length) * totalDuration);
      }
    }

    return startTimes;
  }

  // ── Preload helpers ───────────────────────────────────────────────────────────

  /** Preload the next chapter's audio element and timestamps into cache. */
  #preloadNextChapter(currentChapterIndex: number): void {
    if (!this.#manifest) return;
    const nextChapter = this.#manifest.chapters.find((c) => c.index === currentChapterIndex + 1);
    if (!nextChapter) return;

    if (!this.#nextAudioEl) {
      this.#nextAudioEl = new Audio();
      this.#nextAudioEl.preload = 'auto';
    }
    if (this.#nextAudioEl.src !== nextChapter.audio_url) {
      this.#nextAudioEl.src = nextChapter.audio_url;
    }
    // Fire-and-forget timestamps prefetch into cache
    this.#loadTimestamps(nextChapter.timestamps_url);
  }

  // ── Resume position ───────────────────────────────────────────────────────────

  #positionKey(chapterIndex: number): string {
    return `audiobook-pos:${this.#manifestUrl}:${chapterIndex}`;
  }

  #savePosition(): void {
    if (!this.#audioEl || this.#currentChapterIndex < 0) return;
    const t = this.#audioEl.currentTime;
    if (t > 0) {
      localStorage.setItem(this.#positionKey(this.#currentChapterIndex), String(t));
    }
  }

  #loadPosition(chapterIndex: number): number {
    const raw = localStorage.getItem(this.#positionKey(chapterIndex));
    return raw ? parseFloat(raw) || 0 : 0;
  }

  // ── Time update ───────────────────────────────────────────────────────────────

  /** Throttled to ~4 Hz; dispatches current playback position to the controller. */
  #handleTimeUpdate = (): void => {
    const now = Date.now();
    if (now - this.#lastTimeDispatchMs < 250) return;
    this.#lastTimeDispatchMs = now;
    if (!this.#audioEl || !this.#manifest) return;
    const chapter = this.#manifest.chapters.find((c) => c.index === this.#currentChapterIndex);
    this.controller?.dispatchEvent(
      new CustomEvent('tts-audiobook-time', {
        detail: {
          currentTime: this.#audioEl.currentTime,
          duration: this.#audioEl.duration || chapter?.duration_seconds || 0,
          chapterTitle: chapter?.title ?? '',
          narratorName: this.#manifest.voice_name,
        },
      }),
    );
  };

  // ── Error dispatching ─────────────────────────────────────────────────────────

  #dispatchError(message: string): void {
    this.controller?.dispatchEvent(new CustomEvent('tts-error', { detail: { message } }));
  }

  // ── Playback helpers ─────────────────────────────────────────────────────────

  /** Resolves when audio.currentTime >= targetTime, the audio ends, or signal fires. */
  #waitUntilTime(targetTime: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const audio = this.#audioEl!;
      let rafId: number;

      const done = () => {
        cancelAnimationFrame(rafId);
        resolve();
      };

      const tick = () => {
        if (signal.aborted || audio.ended || audio.paused || audio.currentTime >= targetTime) {
          done();
          return;
        }
        rafId = requestAnimationFrame(tick);
      };

      signal.addEventListener('abort', done, { once: true });
      audio.addEventListener('ended', done, { once: true });
      rafId = requestAnimationFrame(tick);
    });
  }

  // ── Core speak ───────────────────────────────────────────────────────────────

  async *speak(ssml: string, signal: AbortSignal, preload = false): AsyncIterable<TTSMessageEvent> {
    // Preload is a no-op for audiobooks; we can't pre-synthesise
    if (preload) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    if (!this.#manifest || !this.#audioEl) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    const sectionLabel = this.controller?.sectionLabel ?? '';
    const chapter = this.#findChapter(sectionLabel);

    if (!chapter) {
      console.info(`[AudiobookTTSClient] No chapter matched "${sectionLabel}" — skipping`);
      this.#dispatchError(
        `No audiobook chapter matched "${sectionLabel}". Check that the manifest title matches the EPUB chapter.`,
      );
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    const timestamps = await this.#loadTimestamps(chapter.timestamps_url);
    if (!timestamps || timestamps.words.length === 0) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    const { marks } = parseSSMLMarks(ssml, this.#primaryLang);
    if (marks.length === 0) {
      yield { code: 'end' } as TTSMessageEvent;
      return;
    }

    // Load new audio source only when the chapter changes; restore saved position
    if (this.#currentChapterIndex !== chapter.index) {
      // Swap in preloaded element if it already has the right src
      if (
        this.#nextAudioEl &&
        this.#nextAudioEl.src === chapter.audio_url &&
        this.#nextAudioEl.readyState >= 2
      ) {
        const prev = this.#audioEl;
        prev.pause();
        this.#audioEl = this.#nextAudioEl;
        this.#nextAudioEl = prev; // recycle for next preload
        this.#nextAudioEl.src = '';
      } else {
        this.#audioEl.src = chapter.audio_url;
      }
      this.#audioEl.playbackRate = this.#playbackRate;
      this.#currentChapterIndex = chapter.index;

      const savedPos = this.#loadPosition(chapter.index);
      if (savedPos > 0) {
        this.#audioEl.currentTime = savedPos;
      }
    }

    // Preload the next chapter in the background
    this.#preloadNextChapter(chapter.index);

    const sentenceStartTimes = this.#buildSentenceStartTimes(timestamps.words, marks);

    try {
      await this.#audioEl.play();
    } catch (e) {
      console.warn('[AudiobookTTSClient] play() failed:', e);
      yield { code: 'error', message: String(e) } as TTSMessageEvent;
      return;
    }

    // Iterate through sentence marks, highlighting each as audio reaches it
    for (let i = 0; i < marks.length; i++) {
      if (signal.aborted) break;

      const mark = marks[i]!;
      const sentenceStart = sentenceStartTimes[i] ?? 0;
      const nextSentenceStart = sentenceStartTimes[i + 1] ?? chapter.duration_seconds;

      // Seek if audio has drifted beyond threshold
      if (Math.abs(this.#audioEl.currentTime - sentenceStart) > SEEK_DRIFT_THRESHOLD_SEC) {
        this.#audioEl.currentTime = sentenceStart;
      }

      // Wait until we reach this sentence in the audio
      await this.#waitUntilTime(sentenceStart + 0.05, signal);

      if (signal.aborted || this.#audioEl.ended) break;

      // Highlight this sentence in the reader
      this.controller?.dispatchSpeakMark(mark);
      yield { code: 'boundary', mark: mark.name } as TTSMessageEvent;

      // Wait until the next sentence starts
      await this.#waitUntilTime(nextSentenceStart, signal);
    }

    if (signal.aborted) {
      this.#audioEl.pause();
      this.#savePosition();
      yield { code: 'error', message: 'Aborted' } as TTSMessageEvent;
      return;
    }

    // Wait for audio to finish naturally
    if (!this.#audioEl.ended) {
      await new Promise<void>((resolve) => {
        const onEnded = () => resolve();
        const onAbort = () => resolve();
        this.#audioEl!.addEventListener('ended', onEnded, { once: true });
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    yield { code: 'end' } as TTSMessageEvent;
  }

  // ── Transport controls ───────────────────────────────────────────────────────

  async pause(): Promise<boolean> {
    this.#audioEl?.pause();
    this.#savePosition();
    return true;
  }

  async resume(): Promise<boolean> {
    try {
      await this.#audioEl?.play();
    } catch {}
    return true;
  }

  async stop(): Promise<void> {
    if (this.#audioEl) {
      this.#savePosition();
      this.#audioEl.pause();
      this.#audioEl.currentTime = 0;
    }
    this.#currentChapterIndex = -1;
  }

  /** Skip backward by the given number of seconds (default 15). */
  async skipBack(seconds = 15): Promise<void> {
    if (this.#audioEl) {
      this.#audioEl.currentTime = Math.max(0, this.#audioEl.currentTime - seconds);
    }
  }

  /** Skip forward by the given number of seconds (default 30). */
  async skipForward(seconds = 30): Promise<void> {
    if (this.#audioEl) {
      this.#audioEl.currentTime = Math.min(
        this.#audioEl.duration || 0,
        this.#audioEl.currentTime + seconds,
      );
    }
  }

  /** Seek to an absolute time in seconds within the current chapter. */
  async seekTo(seconds: number): Promise<void> {
    if (this.#audioEl) {
      this.#audioEl.currentTime = Math.max(0, Math.min(this.#audioEl.duration || 0, seconds));
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  setPrimaryLang(lang: string): void {
    this.#primaryLang = lang;
  }

  async setRate(rate: number): Promise<void> {
    this.#playbackRate = rate;
    if (this.#audioEl) this.#audioEl.playbackRate = rate;
  }

  async setPitch(_pitch: number): Promise<void> {
    // Pitch adjustment on HTMLAudioElement requires Web Audio API — skipped for now
  }

  async setVoice(_voice: string): Promise<void> {
    // Audiobooks have a fixed voice baked in at generation time
  }

  // ── Voice enumeration ────────────────────────────────────────────────────────

  async getAllVoices(): Promise<TTSVoice[]> {
    if (!this.#manifest) return [];
    return [
      {
        id: 'audiobook',
        name: `Audiobook — ${this.#manifest.voice_name}`,
        lang: 'en',
      },
    ];
  }

  async getVoices(_lang: string): Promise<TTSVoicesGroup[]> {
    return [
      {
        id: 'audiobook',
        name: 'Audiobook',
        voices: await this.getAllVoices(),
        disabled: !this.initialized,
      },
    ];
  }

  getGranularities(): TTSGranularity[] {
    return ['sentence'];
  }

  getVoiceId(): string {
    return 'audiobook';
  }

  getSpeakingLang(): string {
    return this.#speakingLang;
  }

  // ── Public helpers ───────────────────────────────────────────────────────────

  /** The number of chapters available in this audiobook (for UI display). */
  get chapterCount(): number {
    return this.#manifest?.total_chapters ?? 0;
  }

  /** Title of the audiobook (for UI display). */
  get audiobookTitle(): string {
    return this.#manifest?.title ?? '';
  }

  /** Narrator (voice) name for display. */
  get narratorName(): string {
    return this.#manifest?.voice_name ?? '';
  }

  /** All chapters for the chapter-list UI. */
  getChapters(): { index: number; title: string; duration_seconds: number }[] {
    return (
      this.#manifest?.chapters.map((c) => ({
        index: c.index,
        title: c.title,
        duration_seconds: c.duration_seconds,
      })) ?? []
    );
  }

  /**
   * Set the current chapter directly (used when the user jumps from the chapter list).
   * Updates sectionLabel/sectionIndex on the controller so the next speak() call
   * picks the right chapter without waiting for a reader navigation event.
   */
  setCurrentChapterByIndex(chapterIndex: number): void {
    const chapter = this.#manifest?.chapters.find((c) => c.index === chapterIndex);
    if (!chapter || !this.controller) return;
    this.controller.sectionLabel = chapter.title;
    this.controller.sectionIndex = chapterIndex - 1;
  }
}
